/**
 * Wire protocol shared between the extension host and the DSH chat webview.
 *
 * Keep this file dependency-free: it is compiled into both the Node extension
 * bundle and the browser webview bundle, so it must not import `vscode`, Node
 * built-ins or any DOM API.
 */

export type BackendStatus = 'stopped' | 'starting' | 'ready' | 'error';

export type PermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface WorkspaceInfo {
  /** Human readable workspace name. */
  name: string;
  /** Absolute path of the workspace root the agent runs in. */
  cwd: string;
  /** True when a single folder is open (vs. a multi-root or empty window). */
  isSingleFolder: boolean;
}

export interface ModelInfo {
  /** Composite `<provider>:<model>` id used on the wire. */
  id: string;
  provider: string;
  model: string;
  label: string;
  description?: string;
  contextWindow?: number;
  /** Reasoning effort levels advertised by the model, when any. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  vendor?: string;
}

export interface AgentPresetInfo {
  id: string;
  name: string;
  description?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd?: string;
  updatedAt?: number;
  running?: boolean;
}

export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  contextUsed?: number;
  contextWindow?: number;
}

export interface SessionInfo {
  id: string | null;
  title: string;
  model: ModelInfo | null;
  reasoningEffort?: string;
  permission: PermissionPreset;
  agentPreset: string | null;
  running: boolean;
  usage?: SessionUsage;
}

export type ChatPart = TextPart | ReasoningPart | ToolPart | NoticePart;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  collapsed?: boolean;
}

export interface NoticePart {
  type: 'notice';
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface ToolPart {
  type: 'tool';
  toolId: string;
}

export interface FileDiffSummary {
  /** Workspace-relative path when possible. */
  path: string;
  added: number;
  removed: number;
  /** Unified diff text, used for the inline preview. */
  patch?: string;
  /** Full previous content, when the transport can provide it (enables a real diff editor). */
  oldText?: string;
  /** Full new content, when the transport can provide it (enables a real diff editor). */
  newText?: string;
}

export type ToolStatus = 'pending' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'canceled';

export interface ToolCall {
  id: string;
  /** Wire tool name, e.g. `str_replace_editor`, `pwsh`, `web_search`. */
  name: string;
  /** Short human title, e.g. "Editing src/app.ts". */
  title: string;
  status: ToolStatus;
  /** Raw input rendered as compact JSON (truncated by the host). */
  input?: string;
  /** Tool output / error text (truncated by the host). */
  output?: string;
  /** Set when the tool changed files. */
  diff?: FileDiffSummary;
  /** Non-null while the tool is waiting for a user decision. */
  approvalId?: string;
  /** Sub-agent invocations render as a nested run. */
  childSessionId?: string;
  startedAt: number;
  endedAt?: number;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'streaming' | 'done' | 'error' | 'aborted';

export interface Attachment {
  kind: 'file' | 'selection' | 'diagnostics' | 'terminal' | 'image';
  label: string;
  /** Absolute path for file-backed attachments. */
  path?: string;
  /** 1-based line range for selection attachments. */
  startLine?: number;
  endLine?: number;
  /** Pre-rendered text injected into the prompt. */
  text?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  createdAt: number;
  parts: ChatPart[];
  status: MessageStatus;
  error?: string;
  attachments?: Attachment[];
}

export interface ChatState {
  workspace: WorkspaceInfo;
  backend: {
    status: BackendStatus;
    /** Human readable detail, e.g. "starting on 127.0.0.1:3080" or an error message. */
    detail?: string;
    /** True when we adopted a server we did not spawn. */
    reused?: boolean;
  };
  session: SessionInfo;
  messages: ChatMessage[];
  tools: Record<string, ToolCall>;
  sessions: SessionSummary[];
  models: ModelInfo[];
  agentPresets: AgentPresetInfo[];
  config: {
    includeDiagnostics: boolean;
    confirmBeforeSend: boolean;
  };
}

export interface ApprovalRequest {
  id: string;
  toolCallId?: string;
  toolName: string;
  title: string;
  detail?: string;
  /** Option ids, first one is the default highlight. */
  options: Array<{ id: string; label: string; description?: string; danger?: boolean }>;
}

/* ------------------------------------------------------------------ */
/* Host -> webview                                                     */
/* ------------------------------------------------------------------ */

export type HostMessage =
  | { type: 'init'; state: ChatState }
  | { type: 'state'; patch: DeepPartial<ChatState> }
  | { type: 'backend'; status: BackendStatus; detail?: string; reused?: boolean }
  | { type: 'session'; session: SessionInfo }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'models'; models: ModelInfo[] }
  | { type: 'agent-presets'; presets: AgentPresetInfo[] }
  | { type: 'clear' }
  | { type: 'message'; message: ChatMessage }
  | { type: 'part'; messageId: string; index: number; part: ChatPart }
  | { type: 'delta'; messageId: string; index: number; text: string }
  | { type: 'message-status'; messageId: string; status: MessageStatus; error?: string }
  | { type: 'tool'; tool: ToolCall }
  | { type: 'approval'; request: ApprovalRequest | null }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'focus-composer' }
  | { type: 'composer'; text: string; attachments?: Attachment[] }
  | { type: 'toast'; level: 'info' | 'warning' | 'error'; text: string };

/* ------------------------------------------------------------------ */
/* Webview -> host                                                     */
/* ------------------------------------------------------------------ */

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; attachments: Attachment[] }
  | { type: 'stop' }
  | { type: 'new-session' }
  | { type: 'switch-session'; sessionId: string }
  | { type: 'request-sessions' }
  | { type: 'pick-model' }
  | { type: 'pick-permission' }
  | { type: 'pick-agent' }
  | { type: 'approval'; id: string; optionId: string }
  | { type: 'open-file'; path: string; line?: number; endLine?: number }
  | { type: 'open-diff'; toolId: string }
  | { type: 'copy'; text: string }
  | { type: 'attach-files' }
  | { type: 'attach-selection' }
  | { type: 'attach-problems' }
  | { type: 'remove-attachment'; index: number }
  | { type: 'restart-backend' }
  | { type: 'start-backend' }
  | { type: 'show-logs' }
  | { type: 'open-settings' }
  | { type: 'copy-session-id' };

/* ------------------------------------------------------------------ */
/* Backend-independent agent events (produced by a transport adapter)  */
/* ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: 'backend-ready'; detail?: string }
  | { type: 'backend-exit'; code?: number | null; signal?: string | null; error?: string }
  | { type: 'session'; session: SessionInfo }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'models'; models: ModelInfo[] }
  | { type: 'agent-presets'; presets: AgentPresetInfo[] }
  | { type: 'message-start'; message: ChatMessage }
  | { type: 'part'; messageId: string; index: number; part: ChatPart }
  | { type: 'delta'; messageId: string; index: number; text: string }
  | { type: 'message-status'; messageId: string; status: MessageStatus; error?: string }
  | { type: 'tool'; tool: ToolCall }
  | { type: 'approval'; request: ApprovalRequest | null }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'log'; text: string };

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const PERMISSION_PRESETS: ReadonlyArray<{ id: PermissionPreset; label: string; description: string }> = [
  {
    id: 'read-only',
    label: 'Read-only',
    description: 'The agent may inspect the workspace but all writes are blocked.',
  },
  {
    id: 'workspace-write',
    label: 'Workspace write',
    description: 'The agent may modify files inside the workspace; wider access needs approval.',
  },
  {
    id: 'danger-full-access',
    label: 'Full access',
    description: 'The agent may modify any file without approval prompts.',
  },
];
