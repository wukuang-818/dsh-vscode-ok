/**
 * Pure mappings from the DSH web wire protocol onto the extension's
 * {@link AgentEvent} union.
 *
 * Everything here is framework free (no `vscode`, no network, no timers) so the
 * mapping can be unit tested with plain objects. The stateful backend feeds
 * decoded mux items and durable SessionEvents through these functions and
 * forwards the returned events to the chat controller.
 */

import type {
  AgentEvent,
  ApprovalRequest,
  Attachment,
  ChatMessage,
  ChatPart,
  CommandInfo,
  FileDiffSummary,
  ModelInfo,
  PermissionPreset,
  SessionInfo,
  SessionSearchHit,
  SessionSummary,
  SessionUsage,
  SkillInfo,
  ToolCall,
  ToolStatus,
} from '../shared/protocol';
import type { SendInput } from './backend';

/** Durable session event envelope as it appears on `session/follow`. */
export interface SessionEventEnvelope {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  surfaceOp?: string;
}

export interface PendingApproval {
  approvalId: string;
  eventId: string;
  agentId: string;
  clientId: string;
  callId?: string;
  toolName: string;
}

interface AttemptBlock {
  partIndex: number;
  kind: 'text' | 'reasoning' | 'tool';
}

interface AttemptState {
  attemptId: string;
  live: boolean;
  blocks: Map<number, AttemptBlock>;
}

/**
 * Mutable bookkeeping shared by the mapping functions. A backend owns one
 * context per session-follow stream; tests can construct one by hand.
 */
export interface WireContext {
  sessionId: string | null;
  clientId: string;
  messageId: string;
  baselineSeq: number;
  running: boolean;
  title: string;
  permission: PermissionPreset;
  model: ModelInfo | null;
  agentPreset: string | null;
  reasoningEffort: string | undefined;
  usage: SessionUsage | undefined;
  messageStarted: boolean;
  expectUserEcho: boolean;
  partIndex: number;
  tools: Map<string, ToolCall>;
  toolParts: Set<string>;
  pendingApprovals: Map<string, PendingApproval>;
  sessions: Map<string, SessionSummary>;
  attempt: AttemptState | undefined;
  turn: number;
  step: number;
}

export interface WireContextInit {
  sessionId: string | null;
  clientId?: string;
  messageId: string;
  permission?: PermissionPreset;
  model?: ModelInfo | null;
  agentPreset?: string | null;
  reasoningEffort?: string | undefined;
  title?: string;
}

export function createWireContext(init: WireContextInit): WireContext {
  return {
    sessionId: init.sessionId,
    clientId: init.clientId ?? '',
    messageId: init.messageId,
    baselineSeq: -1,
    running: false,
    title: init.title ?? 'New session',
    permission: init.permission ?? 'workspace-write',
    model: init.model ?? null,
    agentPreset: init.agentPreset ?? null,
    reasoningEffort: init.reasoningEffort,
    usage: undefined,
    messageStarted: false,
    expectUserEcho: false,
    partIndex: 0,
    tools: new Map(),
    toolParts: new Set(),
    pendingApprovals: new Map(),
    sessions: new Map(),
    attempt: undefined,
    turn: 0,
    step: 0,
  };
}

/** Reset per-turn streaming state without discarding session level data. */
export function resetTurnState(ctx: WireContext, messageId: string): void {
  ctx.messageId = messageId;
  ctx.messageStarted = false;
  ctx.partIndex = 0;
  ctx.attempt = undefined;
  ctx.turn = 0;
  ctx.step = 0;
}

const PERMISSION_VALUES: readonly PermissionPreset[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asPermission(value: unknown): PermissionPreset | undefined {
  return PERMISSION_VALUES.find((preset) => preset === value);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

function partsFromContent(content: unknown): ChatPart[] {
  const parts: ChatPart[] = [];
  if (!Array.isArray(content)) return parts;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text) {
      parts.push({ type: 'reasoning', text: block.text });
    }
  }
  return parts;
}

/** Human readable one-line summary of a tool invocation's arguments. */
export function toolTitle(name: string, argumentsText: unknown): string {
  const raw = typeof argumentsText === 'string' ? argumentsText : '';
  let parsed: Record<string, unknown> | undefined;
  if (raw) {
    try {
      const value = JSON.parse(raw) as unknown;
      if (isRecord(value)) parsed = value;
    } catch {
      parsed = undefined;
    }
  }
  const pick = (key: string): string | undefined => {
    if (!parsed) return undefined;
    const value = parsed[key];
    return typeof value === 'string' ? value : undefined;
  };
  const detail =
    pick('description') ??
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('query') ??
    pick('url') ??
    (raw ? raw.slice(0, 80) : '');
  const label = detail.replace(/\s+/g, ' ').trim();
  return label ? `${name}: ${label.slice(0, 120)}` : name;
}

function toolEvent(tool: ToolCall): AgentEvent {
  return { type: 'tool', tool };
}

function sessionInfo(ctx: WireContext): SessionInfo {
  return {
    id: ctx.sessionId,
    title: ctx.title,
    model: ctx.model,
    ...(ctx.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {}),
    permission: ctx.permission,
    agentPreset: ctx.agentPreset,
    running: ctx.running,
    ...(ctx.usage ? { usage: ctx.usage } : {}),
  };
}

export function sessionEvent(ctx: WireContext): AgentEvent {
  return { type: 'session', session: sessionInfo(ctx) };
}

function ensureMessage(ctx: WireContext): AgentEvent[] {
  if (ctx.messageStarted) return [];
  ctx.messageStarted = true;
  const message: ChatMessage = {
    id: ctx.messageId,
    role: 'assistant',
    createdAt: Date.now(),
    parts: [],
    status: 'streaming',
  };
  return [{ type: 'message-start', message }];
}

function allocatePart(ctx: WireContext): number {
  const index = ctx.partIndex;
  ctx.partIndex += 1;
  return index;
}

function startTextPart(
  ctx: WireContext,
  attempt: AttemptState,
  blockIndex: number,
  kind: 'text' | 'reasoning',
): AgentEvent[] {
  const existing = attempt.blocks.get(blockIndex);
  if (existing) return [];
  const part: ChatPart =
    kind === 'text' ? { type: 'text', text: '' } : { type: 'reasoning', text: '' };
  const index = allocatePart(ctx);
  attempt.blocks.set(blockIndex, { partIndex: index, kind });
  return [...ensureMessage(ctx), { type: 'part', messageId: ctx.messageId, index, part }];
}

function emitDelta(
  ctx: WireContext,
  attempt: AttemptState,
  blockIndex: number,
  kind: 'text' | 'reasoning',
  text: string,
): AgentEvent[] {
  if (!text) return [];
  const block = attempt.blocks.get(blockIndex);
  if (!block) return [];
  return [{ type: 'delta', messageId: ctx.messageId, index: block.partIndex, text }];
}

function toolCallFromData(
  ctx: WireContext,
  callId: string,
  name: string,
  argumentsText: unknown,
  status: ToolStatus,
  now: number,
): ToolCall {
  const input = typeof argumentsText === 'string' ? argumentsText : undefined;
  const existing = ctx.tools.get(callId);
  const tool: ToolCall = {
    id: callId,
    name,
    title: toolTitle(name, argumentsText),
    status,
    ...(input ? { input } : {}),
    startedAt: existing?.startedAt ?? now,
    ...(existing?.endedAt !== undefined ? { endedAt: existing.endedAt } : {}),
    ...(existing?.diff ? { diff: existing.diff } : {}),
    ...(existing?.output !== undefined ? { output: existing.output } : {}),
  };
  ctx.tools.set(callId, tool);
  return tool;
}

function ensureToolPart(ctx: WireContext, tool: ToolCall): AgentEvent[] {
  const events = ensureMessage(ctx);
  if (ctx.toolParts.has(tool.id)) return events;
  ctx.toolParts.add(tool.id);
  const index = allocatePart(ctx);
  events.push({ type: 'part', messageId: ctx.messageId, index, part: { type: 'tool', toolId: tool.id } });
  return events;
}

function toolCallEvents(
  ctx: WireContext,
  callId: string,
  name: string,
  argumentsText: unknown,
  status: ToolStatus,
  now: number,
): AgentEvent[] {
  const tool = toolCallFromData(ctx, callId, name, argumentsText, status, now);
  const events = ensureToolPart(ctx, tool);
  events.push(toolEvent(tool));
  return events;
}

const TOOL_STATUS_RANK: Record<ToolStatus, number> = {
  pending: 0,
  'awaiting-approval': 1,
  running: 2,
  done: 3,
  error: 3,
  canceled: 3,
};

function canAdvance(current: ToolStatus, next: ToolStatus): boolean {
  if (current === next) return true;
  if (TOOL_STATUS_RANK[current] > TOOL_STATUS_RANK[next]) return false;
  return true;
}

function updateTool(
  ctx: WireContext,
  callId: string,
  patch: Partial<ToolCall> & { status?: ToolStatus },
): AgentEvent[] {
  const existing = ctx.tools.get(callId);
  const name = patch.name ?? existing?.name ?? 'tool';
  const previous: ToolCall = existing ?? {
    id: callId,
    name,
    title: toolTitle(name, patch.input ?? ''),
    status: 'pending',
    startedAt: Date.now(),
  };
  const status = patch.status && canAdvance(previous.status, patch.status) ? patch.status : previous.status;
  const tool: ToolCall = {
    ...previous,
    ...patch,
    status,
  };
  ctx.tools.set(callId, tool);
  return [toolEvent(tool)];
}

/** Line level diff counts for a meta-provided `oldText`/`newText` pair. */
export function diffCounts(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  const before = oldText.split(/\r?\n/);
  const after = newText.split(/\r?\n/);
  if (before.length * after.length > 40_000) {
    return { added: after.length, removed: before.length };
  }
  let common = 0;
  const previous = new Array<number>(after.length + 1).fill(0);
  for (let i = 1; i <= before.length; i += 1) {
    const current = new Array<number>(after.length + 1).fill(0);
    for (let j = 1; j <= after.length; j += 1) {
      const match = before[i - 1] === after[j - 1];
      current[j] = match ? (previous[j - 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    for (let j = 0; j <= after.length; j += 1) previous[j] = current[j] ?? 0;
  }
  common = previous[after.length] ?? 0;
  return { added: after.length - common, removed: before.length - common };
}

/** Build a {@link FileDiffSummary} from the `meta` field of a tool result. */
export function fileDiffFromMeta(meta: unknown): FileDiffSummary | undefined {
  if (!isRecord(meta)) return undefined;
  const path = asString(meta.path);
  const diffs = Array.isArray(meta.diffs) ? meta.diffs : [];
  for (const entry of diffs) {
    if (!isRecord(entry)) continue;
    const entryPath = asString(entry.path) ?? path;
    const oldText = asString(entry.oldText);
    const newText = asString(entry.newText);
    const patch = asString(entry.patch);
    if (!entryPath) continue;
    if (oldText !== undefined || newText !== undefined) {
      const counts = diffCounts(oldText ?? '', newText ?? '');
      return {
        path: entryPath,
        added: counts.added,
        removed: counts.removed,
        ...(patch ? { patch } : {}),
        ...(oldText !== undefined ? { oldText } : {}),
        ...(newText !== undefined ? { newText } : {}),
      };
    }
    if (patch) {
      return { path: entryPath, added: 0, removed: 0, patch };
    }
  }
  if (path && typeof meta.operation === 'string' && meta.operation === 'create') {
    return { path, added: 0, removed: 0 };
  }
  return undefined;
}

export function mapSessionEvent(event: SessionEventEnvelope, ctx: WireContext): AgentEvent[] {
  if (typeof event.seq === 'number' && event.seq <= ctx.baselineSeq) return [];
  const data = isRecord(event.data) ? event.data : {};
  const now = typeof event.time === 'number' ? event.time : Date.now();

  switch (event.type) {
    case 'turn/start': {
      ctx.turn = asNumber(data.turn) ?? ctx.turn + 1;
      ctx.step = 0;
      return [];
    }
    case 'step/start': {
      ctx.step = asNumber(data.step) ?? ctx.step + 1;
      return [];
    }
    case 'assistant/attempt': {
      // Fallback path: live assistant frames are unavailable (reconnect or a
      // runtime without assistantStream), rebuild content from durable chunks.
      if (ctx.attempt?.live) return [];
      const attempt: AttemptState = { attemptId: `durable-${String(event.seq)}`, live: false, blocks: new Map() };
      ctx.attempt = attempt;
      const events: AgentEvent[] = [];
      const stream = Array.isArray(data.stream) ? data.stream : [];
      for (const record of stream) {
        events.push(...mapAssistantChunk(record, attempt, ctx, now));
      }
      return events;
    }
    case 'assistant/message': {
      const message = isRecord(data.message) ? data.message : undefined;
      const content = message?.content;
      const events: AgentEvent[] = [];
      const attempt = ctx.attempt;
      if (Array.isArray(content)) {
        content.forEach((block, blockIndex) => {
          if (!isRecord(block)) return;
          const type = asString(block.type);
          const text = asString(block.text) ?? '';
          if (type === 'text' || type === 'reasoning') {
            const kind = type === 'text' ? 'text' : 'reasoning';
            const mapped = attempt?.blocks.get(blockIndex);
            if (mapped && mapped.kind === kind) {
              events.push(...ensureMessage(ctx));
              events.push({
                type: 'part',
                messageId: ctx.messageId,
                index: mapped.partIndex,
                part: kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text },
              });
            } else if (text) {
              const target = attempt ?? { attemptId: 'durable', live: false, blocks: new Map<number, AttemptBlock>() };
              ctx.attempt = target;
              events.push(...startTextPart(ctx, target, blockIndex, kind));
              const created = target.blocks.get(blockIndex);
              if (created) {
                events.push({
                  type: 'part',
                  messageId: ctx.messageId,
                  index: created.partIndex,
                  part: kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text },
                });
              }
            }
          } else if (type === 'tool-call') {
            const callId = asString(block.id);
            const name = asString(block.name);
            if (callId && name) {
              events.push(...toolCallEvents(ctx, callId, name, block.arguments, 'running', now));
            }
          }
        });
      } else if (typeof content === 'string' && content) {
        events.push(...ensureMessage(ctx));
        const index = allocatePart(ctx);
        events.push({ type: 'part', messageId: ctx.messageId, index, part: { type: 'text', text: content } });
      }
      const usage = isRecord(data.usage) ? data.usage : undefined;
      if (usage) {
        ctx.usage = mergeUsage(ctx.usage, usage);
        events.push(sessionEvent(ctx));
      }
      return events;
    }
    case 'assistant/chunk': {
      const chunk = data.chunk;
      const attempt = ctx.attempt ?? { attemptId: 'durable', live: false, blocks: new Map() };
      ctx.attempt = attempt;
      return mapAssistantChunk({ chunk }, attempt, ctx, now);
    }
    case 'tool/call': {
      const callId = asString(data.callId);
      const name = asString(data.name) ?? 'tool';
      if (!callId) return [];
      return toolCallEvents(ctx, callId, name, data.arguments, 'running', now);
    }
    case 'tool/result': {
      const message = isRecord(data.message) ? data.message : {};
      const source = isRecord(message.source) ? message.source : {};
      const callId = asString(message.toolCallId) ?? asString(source.callId) ?? asString(data.callId);
      if (!callId) return [];
      const isError = message.isError === true || isRecord(data.error);
      const error = isRecord(data.error) ? data.error : undefined;
      const output = textFromContent(message.content) || asString(message.output) || '';
      const diff = fileDiffFromMeta(data.meta);
      const patch: Partial<ToolCall> = {
        status: isError ? 'error' : 'done',
        endedAt: now,
        ...(output ? { output } : {}),
        ...(error && typeof error.message === 'string' ? { output: output || error.message } : {}),
        ...(diff ? { diff } : {}),
      };
      const existing = ctx.tools.get(callId);
      const events = updateTool(ctx, callId, {
        name: existing?.name ?? asString(message.name) ?? 'tool',
        ...patch,
      });
      if (!existing) events.push(...ensureToolPart(ctx, ctx.tools.get(callId) as ToolCall));
      return events;
    }
    case 'approval/asked': {
      const callId = asString(data.callId);
      const toolName = asString(data.toolName) ?? 'tool';
      const approvalId = asString(data.id) ?? `approval-${String(event.seq)}`;
      if (!callId) return [];
      return updateTool(ctx, callId, {
        name: ctx.tools.get(callId)?.name ?? toolName,
        status: 'awaiting-approval',
        approvalId,
      });
    }
    case 'approval/decided': {
      const request = findPendingByApproval(ctx, asString(data.id));
      const events: AgentEvent[] = [{ type: 'approval', request: null }];
      const outcome = asString(data.outcome);
      if (request?.callId) {
        events.push(
          ...updateTool(ctx, request.callId, {
            name: ctx.tools.get(request.callId)?.name ?? request.toolName,
            status: outcome === 'allowed-once' ? 'running' : 'canceled',
          }),
        );
      }
      if (request) ctx.pendingApprovals.delete(request.approvalId);
      return events;
    }
    case 'permission/preset': {
      const preset = asPermission(data.preset) ?? asPermission(data.value);
      if (!preset) return [];
      ctx.permission = preset;
      return [sessionEvent(ctx)];
    }
    case 'sandbox/mode': {
      const preset = asPermission(data.mode) ?? asPermission(data.value);
      if (!preset) return [];
      ctx.permission = preset;
      return [sessionEvent(ctx)];
    }
    case 'session/title': {
      const title = asString(data.title);
      if (!title) return [];
      ctx.title = title;
      return [sessionEvent(ctx)];
    }
    case 'user/message': {
      const source = isRecord(data.source) ? data.source : {};
      if (source.kind !== 'user') return [];
      if (ctx.expectUserEcho) {
        ctx.expectUserEcho = false;
        return [];
      }
      const text = textFromContent(data.content);
      if (!text) return [];
      const message: ChatMessage = {
        id: `user-${String(event.seq)}`,
        role: 'user',
        createdAt: now,
        parts: [{ type: 'text', text }],
        status: 'done',
      };
      return [{ type: 'message-start', message }];
    }
    case 'turn/end': {
      const reason = isRecord(data.reason) ? data.reason : {};
      const kind = asString(reason.kind) ?? 'completed';
      const failure = isRecord(reason.error) ? reason.error : undefined;
      const status = kind === 'completed' ? 'done' : kind === 'error' ? 'error' : 'aborted';
      const error = failure && typeof failure.message === 'string' ? failure.message : undefined;
      const events = [...ensureMessage(ctx), { type: 'message-status', messageId: ctx.messageId, status, ...(error ? { error } : {}) } as AgentEvent];
      if (ctx.pendingApprovals.size > 0) {
        ctx.pendingApprovals.clear();
        events.push({ type: 'approval', request: null });
      }
      ctx.running = false;
      ctx.attempt = undefined;
      events.push(sessionEvent(ctx));
      return events;
    }
    case 'todo/write': {
      const todos = extractTodos(data);
      if (!todos) return [];
      const tool: ToolCall = {
        id: `todo-${String(event.seq)}`,
        name: 'todo',
        title: 'Plan updated',
        status: 'done',
        output: todos,
        startedAt: now,
        endedAt: now,
      };
      ctx.tools.set(tool.id, tool);
      return [toolEvent(tool)];
    }
    default:
      return [];
  }
}

function extractTodos(data: Record<string, unknown>): string | undefined {
  const list = Array.isArray(data.todos) ? data.todos : undefined;
  if (!list) return undefined;
  const lines: string[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const text = asString(entry.content) ?? asString(entry.text) ?? asString(entry.title);
    if (!text) continue;
    const status = asString(entry.status) ?? 'pending';
    lines.push(`- [${status}] ${text}`);
  }
  return lines.join('\n');
}

function findPendingByApproval(ctx: WireContext, approvalId: string | undefined): PendingApproval | undefined {
  if (!approvalId) return undefined;
  return ctx.pendingApprovals.get(approvalId);
}

function mergeUsage(current: SessionUsage | undefined, raw: Record<string, unknown>): SessionUsage {
  const input = asNumber(raw.inputTokens);
  const output = asNumber(raw.outputTokens);
  const cached = asNumber(raw.cacheReadTokens);
  const uncached = asNumber(raw.uncachedInputTokens);
  const usage: SessionUsage = { ...(current ?? {}) };
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cached !== undefined) usage.cachedTokens = cached;
  if (uncached !== undefined) usage.inputTokens = uncached + (cached ?? 0);
  return usage;
}

function mapAssistantChunk(
  record: unknown,
  attempt: AttemptState,
  ctx: WireContext,
  now: number,
): AgentEvent[] {
  if (!isRecord(record)) return [];
  const chunk = isRecord(record.chunk) ? record.chunk : record;
  const type = asString(chunk.type);
  const blockIndex = asNumber(chunk.index) ?? 0;

  switch (type) {
    case 'block-start': {
      const blockType = asString(chunk.blockType);
      if (blockType === 'text' || blockType === 'reasoning') {
        return startTextPart(ctx, attempt, blockIndex, blockType);
      }
      return [];
    }
    case 'text-delta': {
      const text = asString(chunk.text) ?? '';
      const events = startTextPart(ctx, attempt, blockIndex, 'text');
      return [...events, ...emitDelta(ctx, attempt, blockIndex, 'text', text)];
    }
    case 'reasoning-delta': {
      const text = asString(chunk.text) ?? '';
      const events = startTextPart(ctx, attempt, blockIndex, 'reasoning');
      return [...events, ...emitDelta(ctx, attempt, blockIndex, 'reasoning', text)];
    }
    case 'tool-call-delta': {
      const callId = asString(chunk.id);
      const name = asString(chunk.name);
      if (!callId || !name) return [];
      if (ctx.toolParts.has(callId)) return [];
      return toolCallEvents(ctx, callId, name, asString(chunk.argumentsDelta), 'pending', now);
    }
    case 'block-end': {
      const block = isRecord(chunk.block) ? chunk.block : undefined;
      if (!block) return [];
      const blockType = asString(block.type);
      if (blockType === 'text' || blockType === 'reasoning') {
        const mapped = attempt.blocks.get(blockIndex);
        const text = asString(block.text) ?? '';
        if (!text) return [];
        const events = mapped ? [] : startTextPart(ctx, attempt, blockIndex, blockType);
        const part = attempt.blocks.get(blockIndex);
        if (!part) return events;
        events.push({
          type: 'part',
          messageId: ctx.messageId,
          index: part.partIndex,
          part: blockType === 'text' ? { type: 'text', text } : { type: 'reasoning', text },
        });
        return events;
      }
      if (blockType === 'tool-call') {
        const callId = asString(block.id);
        const name = asString(block.name) ?? 'tool';
        if (!callId) return [];
        return toolCallEvents(ctx, callId, name, block.arguments, 'running', now);
      }
      return [];
    }
    case 'usage': {
      const usage = isRecord(chunk.usage) ? chunk.usage : undefined;
      if (!usage) return [];
      ctx.usage = mergeUsage(ctx.usage, usage);
      return [sessionEvent(ctx)];
    }
    case 'finish': {
      const reason = isRecord(chunk.reason) ? chunk.reason : undefined;
      const failure = reason && isRecord(reason.failure) ? reason.failure : undefined;
      if (failure && typeof failure.message === 'string') {
        return [{ type: 'notice', level: 'warning', text: failure.message }];
      }
      return [];
    }
    default:
      return [];
  }
}

/** Map one `session/follow` (or `$events`) item value. */
export function mapFollowItem(item: unknown, ctx: WireContext): AgentEvent[] {
  if (!isRecord(item)) return [];
  const type = asString(item.type);
  switch (type) {
    case 'ready': {
      const clientId = asString(item.clientId);
      if (clientId) ctx.clientId = clientId;
      return [];
    }
    case 'emit':
      return mapServerNotification(item, ctx);
    case 'waterfall':
      return mapApprovalRequest(item, ctx);
    case 'snapshot':
      return applySnapshot(item, ctx);
    case 'event': {
      const raw = isRecord(item.event) ? item.event : undefined;
      if (!raw) return [];
      const envelope: SessionEventEnvelope = {
        type: asString(raw.type) ?? 'unknown',
        seq: asNumber(raw.seq) ?? -1,
        time: asNumber(raw.time) ?? Date.now(),
        data: raw.data,
        ...(asString(raw.surfaceOp) ? { surfaceOp: asString(raw.surfaceOp) as string } : {}),
      };
      return mapSessionEvent(envelope, ctx);
    }
    case 'assistant-stream': {
      return mapAssistantStreamFrame(item, ctx);
    }
    default:
      return [];
  }
}

function mapAssistantStreamFrame(item: Record<string, unknown>, ctx: WireContext): AgentEvent[] {
  const frame = isRecord(item.frame) ? item.frame : undefined;
  if (!frame) return [];
  const frameType = asString(frame.type);
  const attemptId = asString(frame.attemptId) ?? 'live';

  if (frameType === 'start') {
    ctx.attempt = { attemptId, live: true, blocks: new Map() };
    ctx.turn = asNumber(frame.turn) ?? ctx.turn;
    ctx.step = asNumber(frame.step) ?? ctx.step;
    return [];
  }
  if (frameType === 'chunk') {
    if (!ctx.attempt || ctx.attempt.attemptId !== attemptId) {
      ctx.attempt = { attemptId, live: true, blocks: new Map() };
    }
    return mapAssistantChunk({ chunk: frame.chunk }, ctx.attempt, ctx, Date.now());
  }
  if (frameType === 'end') {
    const outcome = isRecord(frame.outcome) ? frame.outcome : undefined;
    if (outcome && asString(outcome.kind) === 'abandoned') {
      return [{ type: 'notice', level: 'info', text: 'The live assistant stream was interrupted.' }];
    }
    return [];
  }
  return [];
}

export function mapApprovalRequest(item: Record<string, unknown>, ctx: WireContext): AgentEvent[] {
  const event = asString(item.event);
  if (event === 'approval/request') {
    const request = isRecord(item.request) ? item.request : {};
    const eventId = asString(item.eventId) ?? `approval-${Date.now()}`;
    const agentId = asString(item.agentId) ?? ctx.sessionId ?? '';
    const toolName = asString(request.toolName) ?? 'tool';
    const callId = asString(request.callId);
    const displayReason = isRecord(request.displayReason) ? request.displayReason : undefined;
    const detail =
      (displayReason ? asString(displayReason.en) : undefined) ??
      asString(request.reason) ??
      asString(request.displayReason);
    const requestId = eventId;
    const approval: ApprovalRequest = {
      id: requestId,
      ...(callId ? { toolCallId: callId } : {}),
      toolName,
      title: `Approve ${toolName}`,
      ...(detail ? { detail } : {}),
      options: [
        { id: 'allowed-once', label: 'Allow once' },
        { id: 'rejected', label: 'Deny', danger: true },
      ],
    };
    const pending: PendingApproval = {
      approvalId: requestId,
      eventId,
      agentId,
      clientId: ctx.clientId,
      ...(callId ? { callId } : {}),
      toolName,
    };
    ctx.pendingApprovals.set(requestId, pending);
    const events: AgentEvent[] = [];
    if (callId) {
      events.push(
        ...updateTool(ctx, callId, {
          name: ctx.tools.get(callId)?.name ?? toolName,
          status: 'awaiting-approval',
          approvalId: requestId,
        }),
      );
    }
    events.push({ type: 'approval', request: approval });
    return events;
  }

  if (event === 'question/requested') {
    // There is no UI for interactive questions yet; cancel cleanly so the turn
    // does not hang, and tell the user.
    const pending: PendingApproval = {
      approvalId: asString(item.eventId) ?? `question-${Date.now()}`,
      eventId: asString(item.eventId) ?? '',
      agentId: asString(item.agentId) ?? ctx.sessionId ?? '',
      clientId: ctx.clientId,
      toolName: 'question',
    };
    ctx.pendingApprovals.set(pending.approvalId, pending);
    return [
      {
        type: 'notice',
        level: 'warning',
        text: 'The agent asked a question; interactive questions are not supported here, so the request was cancelled.',
      },
    ];
  }

  if (event === 'approval/resolved' || event === 'approval/cancelled') {
    return [{ type: 'approval', request: null }];
  }
  return [];
}

function applySnapshot(item: Record<string, unknown>, ctx: WireContext): AgentEvent[] {
  const header = isRecord(item.header) ? item.header : {};
  const projections = isRecord(item.projections) ? item.projections : {};
  const values = isRecord(projections.values) ? projections.values : {};
  const id = asString(header.id);
  const asOfSeq = asNumber(projections.asOfSeq);
  if (id) ctx.sessionId = id;
  if (typeof asOfSeq === 'number') ctx.baselineSeq = asOfSeq;
  const title = asString(values.title);
  if (title) ctx.title = title;
  const preset = asString(values.agentPreset) ?? asString(header.agentPreset);
  if (preset) ctx.agentPreset = preset;
  const permissions = isRecord(values.permissions) ? values.permissions : undefined;
  const permission = asPermission(permissions?.currentValue);
  if (permission) ctx.permission = permission;
  const modelSelection = isRecord(values.modelSelection) ? values.modelSelection : undefined;
  const selected = pickModelSelection(modelSelection);
  if (selected) ctx.model = selected.model;
  if (selected?.reasoningEffort) ctx.reasoningEffort = selected.reasoningEffort;
  const tokenUsage = isRecord(values.tokenUsage) ? values.tokenUsage : undefined;
  if (tokenUsage) ctx.usage = mergeUsage(ctx.usage, tokenUsage);
  const pressure = isRecord(values.contextPressure) ? values.contextPressure : undefined;
  if (pressure) {
    const used = asNumber(pressure.usedTokens) ?? asNumber(pressure.contextUsed) ?? asNumber(pressure.tokens);
    const window = asNumber(pressure.windowTokens) ?? asNumber(pressure.contextWindow);
    const usage: SessionUsage = { ...(ctx.usage ?? {}) };
    if (used !== undefined) usage.contextUsed = used;
    if (window !== undefined) usage.contextWindow = window;
    ctx.usage = usage;
  }
  // A snapshot is the reconnect baseline: forget the in-flight attempt so
  // durable replay can rebuild content without duplicating streamed parts.
  ctx.attempt = undefined;
  const events: AgentEvent[] = [sessionEvent(ctx)];
  if (ctx.sessions.size > 0) {
    events.push({ type: 'sessions', sessions: [...ctx.sessions.values()] });
  }
  return events;
}

function pickModelSelection(
  selection: Record<string, unknown> | undefined,
): { model: ModelInfo; reasoningEffort?: string } | undefined {
  if (!selection) return undefined;
  const value = selection.next ?? selection.lastUsed;
  if (!value) return undefined;
  if (typeof value === 'string') {
    const [provider, model] = value.split(':');
    if (!provider || !model) return undefined;
    return { model: { id: value, provider, model, label: model } };
  }
  if (!isRecord(value)) return undefined;
  const provider = asString(value.provider);
  const model = asString(value.model);
  if (!provider || !model) return undefined;
  const effort = asString(value.reasoningEffort);
  return {
    model: { id: `${provider}:${model}`, provider, model, label: model },
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

function mapServerNotification(item: Record<string, unknown>, ctx: WireContext): AgentEvent[] {
  const event = asString(item.event);
  const args = Array.isArray(item.args) ? item.args : [];
  if (event === 'api-session/added') {
    const record = isRecord(args[0]) ? args[0] : undefined;
    if (!record) return [];
    const id = asString(record.sessionId);
    if (!id) return [];
    const projections = isRecord(record.projections) ? record.projections : undefined;
    const values = projections && isRecord(projections.values) ? projections.values : {};
    const title = asString(values.title) ?? 'Untitled session';
    const summary: SessionSummary = {
      id,
      title,
      ...(asString(record.cwd) ? { cwd: asString(record.cwd) as string } : {}),
      ...(asNumber(record.updatedAt) !== undefined ? { updatedAt: asNumber(record.updatedAt) as number } : {}),
      running: record.running === true,
    };
    ctx.sessions.set(id, summary);
    if (id === ctx.sessionId) {
      ctx.title = title;
      ctx.running = summary.running === true;
      return [
        { type: 'sessions', sessions: [...ctx.sessions.values()] },
        sessionEvent(ctx),
      ];
    }
    return [{ type: 'sessions', sessions: [...ctx.sessions.values()] }];
  }
  if (event === 'api-session/status') {
    const id = asString(args[0]);
    const running = args[1] === true;
    if (!id) return [];
    const summary: SessionSummary = ctx.sessions.get(id) ?? { id, title: 'Untitled session', running };
    ctx.sessions.set(id, { ...summary, running });
    const events: AgentEvent[] = [{ type: 'sessions', sessions: [...ctx.sessions.values()] }];
    if (id === ctx.sessionId) {
      ctx.running = running;
      events.push(sessionEvent(ctx));
    }
    return events;
  }
  if (event === 'api-session/activity') {
    const id = asString(args[0]);
    const updatedAt = asNumber(args[1]);
    if (!id || updatedAt === undefined) return [];
    const summary = ctx.sessions.get(id);
    if (summary) ctx.sessions.set(id, { ...summary, updatedAt });
    return [];
  }
  if (event === 'api-session/error') {
    const id = asString(args[0]);
    const message = asString(args[1]) ?? 'Session error';
    if (id !== ctx.sessionId) return [];
    return [{ type: 'notice', level: 'error', text: message }];
  }
  return [];
}

// -- prompt assembly ------------------------------------------------------

function attachmentNote(attachment: Attachment): string {
  switch (attachment.kind) {
    case 'image':
      return attachment.data
        ? `[image: ${attachment.label}] (attached as an image content block)`
        : `[image: ${attachment.label}] (image data is not forwarded by this transport)`;
    case 'file':
    case 'selection': {
      const range =
        attachment.startLine !== undefined
          ? ` (lines ${attachment.startLine}-${attachment.endLine ?? attachment.startLine})`
          : '';
      return `[${attachment.kind}: ${attachment.label}] ${attachment.path ?? ''}${range}`;
    }
    default:
      return `[${attachment.kind}: ${attachment.label}]`;
  }
}

/** Compose the text block sent to `session/prompt` from a chat input. */
export function buildPromptText(input: SendInput): string {
  const blocks: string[] = [input.text];
  for (const attachment of input.attachments) {
    blocks.push(attachmentNote(attachment));
    if (attachment.text) {
      blocks.push('```', attachment.text, '```');
    }
  }
  return blocks.filter((block) => block.length > 0).join('\n\n');
}

/** Media types `session/prompt` accepts for an inline image block. */
export type PromptImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export type PromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: PromptImageMediaType; data: string; name?: string };

const PROMPT_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function isInlineImage(
  attachment: Attachment,
): attachment is Attachment & { data: string; mediaType: PromptImageMediaType } {
  return (
    attachment.kind === 'image' &&
    typeof attachment.data === 'string' &&
    attachment.data.length > 0 &&
    typeof attachment.mediaType === 'string' &&
    PROMPT_IMAGE_MEDIA_TYPES.has(attachment.mediaType)
  );
}

/**
 * Build the `session/prompt` content array: one text block carrying the prompt
 * and every text attachment, followed by one image block per pasted image.
 */
export function buildPromptContent(input: SendInput): PromptContentBlock[] {
  const blocks: PromptContentBlock[] = [];
  const text = buildPromptText(input);
  if (text.length > 0) {
    blocks.push({ type: 'text', text });
  }
  for (const attachment of input.attachments) {
    if (!isInlineImage(attachment)) continue;
    blocks.push({
      type: 'image',
      mediaType: attachment.mediaType,
      data: attachment.data,
      ...(attachment.label ? { name: attachment.label } : {}),
    });
  }
  return blocks;
}

/** Parse `<provider>:<model>` model ids. */
export function parseModelId(modelId: string): { provider: string; model: string } | undefined {
  const index = modelId.indexOf(':');
  if (index <= 0 || index === modelId.length - 1) return undefined;
  return { provider: modelId.slice(0, index), model: modelId.slice(index + 1) };
}

/** Map `session/modelCatalog` to flat {@link ModelInfo} values. */
export function mapModelCatalog(value: unknown): ModelInfo[] {
  const models: ModelInfo[] = [];
  const catalog = isRecord(value) ? value : {};
  const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const provider = asString(group.id) ?? asString(group.provider) ?? 'unknown';
    const vendor = asString(group.name);
    const entries = Array.isArray(group.models) ? group.models : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const model = asString(entry.id);
      if (!model) continue;
      const reasoning = isRecord(entry.reasoning) ? entry.reasoning : undefined;
      const efforts = Array.isArray(reasoning?.efforts)
        ? reasoning.efforts
            .map((effort) => (isRecord(effort) ? asString(effort.id) : undefined))
            .filter((effort): effort is string => Boolean(effort))
        : [];
      const info: ModelInfo = {
        id: `${provider}:${model}`,
        provider,
        model,
        label: asString(entry.name) ?? model,
        ...(asString(entry.description) ? { description: asString(entry.description) as string } : {}),
        ...(asNumber(entry.contextWindow) !== undefined ? { contextWindow: asNumber(entry.contextWindow) as number } : {}),
        ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
        ...(asString(reasoning?.defaultEffort) ? { defaultReasoningEffort: asString(reasoning?.defaultEffort) as string } : {}),
        ...(vendor ? { vendor } : {}),
      };
      models.push(info);
    }
  }
  return models;
}

/** Map `agentPresets/list` entries to {@link AgentPresetInfo} values. */
export function mapAgentPresetList(value: unknown): Array<{ id: string; name: string; description?: string }> {
  const list = isRecord(value) && Array.isArray(value.presets) ? value.presets : [];
  const presets: Array<{ id: string; name: string; description?: string }> = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    if (!id) continue;
    const name = asString(entry.name) ?? id.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
    presets.push({
      id,
      name,
      ...(asString(entry.description) ? { description: asString(entry.description) as string } : {}),
    });
  }
  return presets;
}

/** Map `session/list` items to {@link SessionSummary} values. */
export function mapSessionList(value: unknown): SessionSummary[] {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  const sessions: SessionSummary[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = asString(item.sessionId);
    if (!id) continue;
    const projections = isRecord(item.projections) ? item.projections : undefined;
    const values = projections && isRecord(projections.values) ? projections.values : {};
    sessions.push({
      id,
      title: asString(values.title) ?? 'Untitled session',
      ...(asString(item.cwd) ? { cwd: asString(item.cwd) as string } : {}),
      ...(asNumber(item.updatedAt) !== undefined ? { updatedAt: asNumber(item.updatedAt) as number } : {}),
      running: item.running === true,
    });
  }
  return sessions;
}

/**
 * Map `commands/list` to {@link CommandInfo} values. The runtime returns a bare
 * array of definitions; `input.hint` becomes `inputHint`.
 */
export function mapCommandList(value: unknown): CommandInfo[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.commands)
      ? value.commands
      : [];
  const commands: CommandInfo[] = [];
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const name = asString(entry.name);
    if (!name) continue;
    const input = isRecord(entry.input) ? entry.input : undefined;
    commands.push({
      name,
      ...(asString(entry.description) ? { description: asString(entry.description) as string } : {}),
      ...(asString(input?.hint) ? { inputHint: asString(input?.hint) as string } : {}),
      ...(asString(entry.definitionId) ? { definitionId: asString(entry.definitionId) as string } : {}),
    });
  }
  return commands;
}

/** Map `skills/list` to {@link SkillInfo} values (name falls back to `id`). */
export function mapSkillList(value: unknown): SkillInfo[] {
  const items = isRecord(value) && Array.isArray(value.skills) ? value.skills : [];
  const skills: SkillInfo[] = [];
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const name = asString(entry.name) ?? asString(entry.id);
    if (!name) continue;
    skills.push({
      name,
      ...(asString(entry.description) ? { description: asString(entry.description) as string } : {}),
      ...(asString(entry.path) ? { path: asString(entry.path) as string } : {}),
    });
  }
  return skills;
}

/** Map `session/search` hits to {@link SessionSearchHit} values. */
export function mapSessionSearchResult(value: unknown): SessionSearchHit[] {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  const hits: SessionSearchHit[] = [];
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const sessionId = asString(entry.sessionId);
    if (!sessionId) continue;
    hits.push({ sessionId, snippet: asString(entry.snippet) ?? '' });
  }
  return hits;
}
