/**
 * Pure state reducer for the DSH chat webview.
 *
 * Everything in this module is DOM free: `main.tsx` owns the VS Code
 * `postMessage` bridge and the Preact render tree, while this file owns the
 * transcript bookkeeping. All helpers are exported so they can be unit tested
 * without a browser environment (see `test/webview-state.test.ts`).
 *
 * Host messages are treated as authoritative: arrays are always replaced by a
 * `state` patch, never concatenated, and unknown message types are ignored.
 */

import type {
  ApprovalRequest,
  Attachment,
  ChatMessage,
  ChatPart,
  ChatState,
  DeepPartial,
  HostMessage,
  MessageStatus,
  SessionSearchHit,
  SessionSummary,
  ToolCall,
} from '../shared/protocol';
import type { UsageSummary } from './util';

/* ------------------------------------------------------------------ */
/* Webview-owned state                                                 */
/* ------------------------------------------------------------------ */

export interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}

/** Pending composer content pushed by the host (`{ type: 'composer' }`). */
export interface ComposerFill {
  text: string;
  attachments?: Attachment[];
  /** Monotonic token so a repeated fill with identical text still applies. */
  seq: number;
}

export interface Draft {
  text: string;
  attachments: Attachment[];
}

export interface AppState {
  /** `null` until the host sends `init` (or the first `state` patch). */
  chat: ChatState | null;
  /** Pending approval surfaced as a modal. */
  approval: ApprovalRequest | null;
  toasts: Toast[];
  toastSeq: number;
  /** Incremented by `focus-composer`; `main.tsx` focuses the textarea on change. */
  focusRequest: number;
  /** Latest composer prefill from the host. */
  composerFill: ComposerFill | null;
  composerSeq: number;
  /**
   * Host matches for the session-picker query (`search-results`). Cleared when
   * the query changes so stale hits never render against a new search.
   */
  sessionSearch: SessionSearchHit[];
}

export type AppAction =
  | { type: 'host'; message: HostMessage }
  | { type: 'approval-answer' }
  | { type: 'dismiss-toast'; id: number }
  | { type: 'clear-search' };

export function createInitialState(): AppState {
  return {
    chat: null,
    approval: null,
    toasts: [],
    toastSeq: 0,
    focusRequest: 0,
    composerFill: null,
    composerSeq: 0,
    sessionSearch: [],
  };
}

/**
 * Skeleton `ChatState` used before the host says anything and as the base for
 * `state` patches that arrive before `init` (defensive, the host normally sends
 * `init` first).
 */
export function emptyChatState(): ChatState {
  return {
    workspace: { name: '', cwd: '', isSingleFolder: false },
    backend: { status: 'stopped' },
    session: {
      id: null,
      title: 'New chat',
      model: null,
      permission: 'workspace-write',
      agentPreset: null,
      running: false,
    },
    messages: [],
    tools: {},
    sessions: [],
    models: [],
    agentPresets: [],
    files: [],
    commands: [],
    skills: [],
    config: { includeDiagnostics: true, confirmBeforeSend: true },
  };
}

/* ------------------------------------------------------------------ */
/* Deep partial merge (arrays replaced, objects merged)                */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeValue(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) return patch.slice();
  if (isPlainObject(patch)) {
    const baseObject = isPlainObject(base) ? base : {};
    const merged: Record<string, unknown> = { ...baseObject };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      merged[key] = mergeValue(baseObject[key], value);
    }
    return merged;
  }
  return patch;
}

/** Deep merges `patch` into `base`. Arrays (and `null`) replace wholesale. */
export function mergeDeep<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  return mergeValue(base, patch) as T;
}

/** Applies a host `state` patch to the transcript state. */
export function mergeChatPatch(chat: ChatState, patch: DeepPartial<ChatState>): ChatState {
  return mergeDeep(chat, patch);
}

/* ------------------------------------------------------------------ */
/* Transcript operations (pure `ChatState` -> `ChatState`)             */
/* ------------------------------------------------------------------ */

function replaceMessageAt(chat: ChatState, index: number, message: ChatMessage): ChatState {
  const messages = chat.messages.slice();
  messages[index] = message;
  return { ...chat, messages };
}

/** Replaces a message with the same id, otherwise appends it. */
export function upsertMessage(chat: ChatState, message: ChatMessage): ChatState {
  const index = chat.messages.findIndex((candidate) => candidate.id === message.id);
  if (index >= 0) return replaceMessageAt(chat, index, message);
  return { ...chat, messages: [...chat.messages, message] };
}

/**
 * Upserts `part` at `index` inside a message.
 *
 * - A missing message is a no-op: a part without its message is not renderable.
 * - An out of range index appends (the host truncates / races message creation).
 * - Tool parts are deduplicated by `toolId` so a `tool` event that pre-created
 *   the part does not produce a duplicate when the explicit `part` arrives.
 */
export function upsertPart(chat: ChatState, messageId: string, index: number, part: ChatPart): ChatState {
  const messageIndex = chat.messages.findIndex((candidate) => candidate.id === messageId);
  if (messageIndex < 0) return chat;
  const message = chat.messages[messageIndex];
  if (!message) return chat;

  const parts = message.parts.slice();

  if (part.type === 'tool') {
    const existing = parts.findIndex(
      (candidate) => candidate.type === 'tool' && candidate.toolId === part.toolId,
    );
    if (existing >= 0) {
      parts[existing] = part;
      return replaceMessageAt(chat, messageIndex, { ...message, parts });
    }
  }

  if (index >= 0 && index < parts.length) {
    parts[index] = part;
  } else {
    parts.push(part);
  }
  return replaceMessageAt(chat, messageIndex, { ...message, parts });
}

/**
 * Appends streamed text to a text/reasoning part. The part must already exist,
 * otherwise the delta is dropped: a delta can never create a part because the
 * host owns part ordering.
 */
export function appendDelta(chat: ChatState, messageId: string, index: number, text: string): ChatState {
  if (text === '') return chat;
  const messageIndex = chat.messages.findIndex((candidate) => candidate.id === messageId);
  if (messageIndex < 0) return chat;
  const message = chat.messages[messageIndex];
  if (!message) return chat;

  const part = message.parts[index];
  if (!part) return chat;
  if (part.type !== 'text' && part.type !== 'reasoning') return chat;

  const parts = message.parts.slice();
  parts[index] = { ...part, text: part.text + text };
  return replaceMessageAt(chat, messageIndex, { ...message, parts });
}

/** Updates `status` (and the optional error text) of an existing message. */
export function updateMessageStatus(
  chat: ChatState,
  messageId: string,
  status: MessageStatus,
  error?: string,
): ChatState {
  const messageIndex = chat.messages.findIndex((candidate) => candidate.id === messageId);
  if (messageIndex < 0) return chat;
  const message = chat.messages[messageIndex];
  if (!message) return chat;

  const next: ChatMessage = { ...message, status };
  if (status === 'error') {
    if (error !== undefined) next.error = error;
  } else {
    delete next.error;
  }
  return replaceMessageAt(chat, messageIndex, next);
}

function lastStreamingAssistantIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'assistant' && message.status === 'streaming') return index;
  }
  return -1;
}

/**
 * Upserts `state.tools[tool.id]` and, when no message part references the tool
 * yet, attaches a tool part to the streaming assistant message so a `tool`
 * event that beats its `part` event still renders. A later explicit `part`
 * replaces that slot in place (see `upsertPart`); `Transcript` also renders
 * tools that ended up without a part as a trailing orphan list.
 */
export function upsertTool(chat: ChatState, tool: ToolCall): ChatState {
  const tools: Record<string, ToolCall> = { ...chat.tools, [tool.id]: tool };
  const referenced = chat.messages.some((message) =>
    message.parts.some((part) => part.type === 'tool' && part.toolId === tool.id),
  );
  if (referenced) return { ...chat, tools };

  const ownerIndex = lastStreamingAssistantIndex(chat.messages);
  if (ownerIndex < 0) return { ...chat, tools };
  const owner = chat.messages[ownerIndex];
  if (!owner) return { ...chat, tools };

  const part: ChatPart = { type: 'tool', toolId: tool.id };
  const messages = chat.messages.slice();
  messages[ownerIndex] = { ...owner, parts: [...owner.parts, part] };
  return { ...chat, tools, messages };
}

/** Clears the transcript (new session / host `clear`). */
export function clearTranscript(chat: ChatState): ChatState {
  return { ...chat, messages: [], tools: {} };
}

/** Replaces the session list (never concatenates). */
export function replaceSessions(chat: ChatState, sessions: SessionSummary[]): ChatState {
  return { ...chat, sessions: sessions.slice() };
}

/** Replaces the pending attachment list locally and drops `index`. */
export function removeDraftAttachment(draft: Draft, index: number): Draft {
  if (index < 0 || index >= draft.attachments.length) return draft;
  const attachments = draft.attachments.slice();
  attachments.splice(index, 1);
  return { ...draft, attachments };
}

/* ------------------------------------------------------------------ */
/* Host message reduction                                              */
/* ------------------------------------------------------------------ */

function pushToast(state: AppState, level: Toast['level'], text: string): AppState {
  const id = state.toastSeq + 1;
  return {
    ...state,
    toastSeq: id,
    toasts: [...state.toasts, { id, level, text }],
  };
}

function updateChat(state: AppState, update: (chat: ChatState) => ChatState): AppState {
  if (!state.chat) return state;
  return { ...state, chat: update(state.chat) };
}

function reduceHost(state: AppState, message: HostMessage): AppState {
  switch (message.type) {
    case 'init':
      return { ...state, chat: mergeDeep(emptyChatState(), message.state), approval: null };
    case 'state':
      return { ...state, chat: mergeChatPatch(state.chat ?? emptyChatState(), message.patch) };
    case 'backend':
      return updateChat(state, (chat) => ({
        ...chat,
        backend: { status: message.status, detail: message.detail, reused: message.reused },
      }));
    case 'session':
      return updateChat(state, (chat) => ({ ...chat, session: message.session }));
    case 'sessions':
      return updateChat(state, (chat) => replaceSessions(chat, message.sessions));
    case 'models':
      return updateChat(state, (chat) => ({ ...chat, models: message.models.slice() }));
    case 'agent-presets':
      return updateChat(state, (chat) => ({ ...chat, agentPresets: message.presets.slice() }));
    case 'files':
      return updateChat(state, (chat) => ({ ...chat, files: message.files.slice() }));
    case 'commands':
      return updateChat(state, (chat) => ({ ...chat, commands: message.commands.slice() }));
    case 'skills':
      return updateChat(state, (chat) => ({ ...chat, skills: message.skills.slice() }));
    case 'search-results':
      return { ...state, sessionSearch: message.items.slice() };
    case 'clear':
      return state.chat ? { ...state, chat: clearTranscript(state.chat), approval: null } : state;
    case 'message':
      return updateChat(state, (chat) => upsertMessage(chat, message.message));
    case 'part':
      return updateChat(state, (chat) => upsertPart(chat, message.messageId, message.index, message.part));
    case 'delta':
      return updateChat(state, (chat) => appendDelta(chat, message.messageId, message.index, message.text));
    case 'message-status':
      return updateChat(state, (chat) =>
        updateMessageStatus(chat, message.messageId, message.status, message.error),
      );
    case 'tool':
      return updateChat(state, (chat) => upsertTool(chat, message.tool));
    case 'approval':
      return { ...state, approval: message.request };
    case 'notice':
    case 'toast':
      return pushToast(state, message.level, message.text);
    case 'focus-composer':
      return { ...state, focusRequest: state.focusRequest + 1 };
    case 'composer': {
      const seq = state.composerSeq + 1;
      return {
        ...state,
        composerSeq: seq,
        composerFill: { text: message.text, attachments: message.attachments, seq },
      };
    }
    default:
      return state;
  }
}

/** App reducer: host messages plus a few webview-local actions. */
export function reduceApp(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'host':
      return reduceHost(state, action.message);
    case 'approval-answer':
      return { ...state, approval: null };
    case 'dismiss-toast':
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
    case 'clear-search':
      return state.sessionSearch.length === 0 ? state : { ...state, sessionSearch: [] };
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/* Selectors                                                          */
/* ------------------------------------------------------------------ */

export function selectIsLoading(state: AppState): boolean {
  return state.chat === null;
}

export function selectIsRunning(state: AppState): boolean {
  return state.chat?.session.running ?? false;
}

export function selectBackendReady(state: AppState): boolean {
  return state.chat?.backend.status === 'ready';
}

/** Sending needs a ready backend, a loaded state and no in-flight turn. */
export function selectCanSend(state: AppState): boolean {
  return selectBackendReady(state) && !selectIsRunning(state);
}

export function selectShowEmptyState(state: AppState): boolean {
  return state.chat !== null && state.chat.messages.length === 0;
}

export function selectTool(state: AppState, toolId: string): ToolCall | undefined {
  return state.chat?.tools[toolId];
}

export function selectMessage(state: AppState, messageId: string): ChatMessage | undefined {
  return state.chat?.messages.find((message) => message.id === messageId);
}

export interface ApprovalChoice {
  id: string;
  label: string;
  danger: boolean;
}

export interface ApprovalChoices {
  approve: ApprovalChoice;
  reject: ApprovalChoice | null;
}

function toChoice(option: ApprovalRequest['options'][number]): ApprovalChoice {
  return { id: option.id, label: option.label, danger: option.danger === true };
}

function toChoiceOrNull(
  option: ApprovalRequest['options'][number] | undefined,
): ApprovalChoice | null {
  return option ? toChoice(option) : null;
}

/**
 * Splits approval options into an inline Approve/Reject pair for a tool card.
 * The first option is the host's default (approve); the rejecting option is the
 * last one whose id/label looks like a refusal, falling back to the last option.
 */
export function selectApprovalChoices(request: ApprovalRequest): ApprovalChoices | null {
  const first = request.options[0];
  if (!first) return null;
  const approve = toChoice(first);
  if (request.options.length < 2) return { approve, reject: null };

  const rejectPattern = /reject|deny|cancel|decline|dismiss|no\b/i;
  for (let index = request.options.length - 1; index > 0; index -= 1) {
    const option = request.options[index];
    if (option && rejectPattern.test(`${option.id} ${option.label}`)) {
      return { approve, reject: toChoice(option) };
    }
  }
  return { approve, reject: toChoiceOrNull(request.options[request.options.length - 1]) };
}

/**
 * Option used when the approval modal is dismissed with Escape: the refusing
 * option when one is identifiable, otherwise the host's default (first) option.
 */
export function selectDismissOption(request: ApprovalRequest): string {
  const choices = selectApprovalChoices(request);
  if (!choices) return '';
  if (choices.reject) return choices.reject.id;
  return choices.approve.id;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Token and context numbers for the composer usage footer.
 *
 * `SessionUsage` carries the sanitized fields (`inputTokens`, `outputTokens`,
 * `contextUsed`, `contextWindow`); a host that forwards the raw snapshot may
 * also pass `tokenUsage` and `contextPressure` (`{ used, total }` or a plain
 * number), so both shapes are accepted. Returns `null` when nothing is known.
 */
export function selectUsage(state: AppState): UsageSummary | null {
  const raw: unknown = state.chat?.session.usage;
  if (typeof raw !== 'object' || raw === null) return null;
  const usage = raw as Record<string, unknown>;

  const tokenUsage = isPlainObject(usage.tokenUsage) ? usage.tokenUsage : undefined;
  const total = finiteNumber(tokenUsage?.total) ?? finiteNumber(usage.total) ?? finiteNumber(usage.tokens);
  const input = finiteNumber(usage.inputTokens);
  const output = finiteNumber(usage.outputTokens);
  const tokens = total ?? (input === null && output === null ? null : (input ?? 0) + (output ?? 0));

  let contextUsed = finiteNumber(usage.contextUsed);
  let contextWindow = finiteNumber(usage.contextWindow);
  const pressure = usage.contextPressure;
  if (typeof pressure === 'number') {
    contextUsed = contextUsed ?? finiteNumber(pressure);
  } else if (isPlainObject(pressure)) {
    contextUsed =
      contextUsed ??
      finiteNumber(pressure.used) ??
      finiteNumber(pressure.usedTokens) ??
      finiteNumber(pressure.contextUsed) ??
      finiteNumber(pressure.tokens);
    contextWindow =
      contextWindow ??
      finiteNumber(pressure.total) ??
      finiteNumber(pressure.windowTokens) ??
      finiteNumber(pressure.contextWindow);
  }

  if (tokens === null && contextUsed === null && contextWindow === null) return null;
  return { tokens, contextUsed, contextWindow };
}

/** Host matches for the current session search (empty when none arrived). */
export function selectSessionSearch(state: AppState): SessionSearchHit[] {
  return state.sessionSearch;
}
