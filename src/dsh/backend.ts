import type {
  AgentPresetInfo,
  Attachment,
  ModelInfo,
  PermissionPreset,
  SessionSummary,
} from '../shared/protocol';

export interface SendInput {
  text: string;
  attachments: Attachment[];
}

export interface BackendLaunchOptions {
  host: string;
  port: number;
  reuseExisting: boolean;
  workspaceRoot: string;
  startTimeoutMs: number;
  debug: boolean;
  /** Explicit CLI override from `dsh.executable`; empty means auto-detect. */
  executable?: string;
  /** Extra arguments that precede the transport arguments. */
  executableArgs?: string[];
  /** Explicit DSH_HOME override; empty means use the default ~/.dsh. */
  dshHome?: string;
  /** Profile the runtime should boot (`web` by default for this transport). */
  profile?: string;
  /** Per-RPC timeout for ordinary (non-prompt) calls. */
  commandTimeoutMs?: number;
}

/**
 * Transport-agnostic surface the chat controller drives. Implementations talk
 * to a real DeepSeek Harness runtime (web HTTP/WS or SDK stdio) and translate
 * their protocol into {@link AgentEvent} values.
 */
export interface Backend {
  /** Human readable transport name, used in logs and the status UI. */
  readonly kind: string;

  /** Spawn/adopt the runtime and resolve once it is ready to accept prompts. */
  start(): Promise<void>;
  /** Stop a runtime we spawned; adopted servers are left running. */
  stop(): Promise<void>;
  /** True while the transport is usable. */
  isReady(): boolean;

  send(input: SendInput): Promise<void>;
  interrupt(): Promise<void>;

  newSession(): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;

  setModel(modelId: string): Promise<void>;
  setPermission(preset: PermissionPreset): Promise<void>;
  setAgentPreset(presetId: string): Promise<void>;
  setReasoningEffort(effort: string): Promise<void>;

  answerApproval(approvalId: string, optionId: string): Promise<void>;

  /** Optional capability probe; undefined means "ask the runtime". */
  listModels?(): Promise<ModelInfo[]>;
  listAgentPresets?(): Promise<AgentPresetInfo[]>;
}

export interface BackendFactoryOptions extends BackendLaunchOptions {
  emit: (event: import('../shared/protocol').AgentEvent) => void;
}
