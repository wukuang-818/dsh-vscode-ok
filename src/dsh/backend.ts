import type {
  AgentPresetInfo,
  Attachment,
  CommandInfo,
  ModelInfo,
  PermissionPreset,
  SessionSearchHit,
  SessionSummary,
  SkillInfo,
} from '../shared/protocol';

export interface SendInput {
  text: string;
  attachments: Attachment[];
}

/** Outcome of `session/rename`; the runtime also reports the resulting seq. */
export interface SessionRenameResult {
  title: string;
  seq?: number;
}

/**
 * Outcome of one `commands/execute` call.
 *
 * `fallbackPrompt` is set when the runtime refused the command RPC and the line
 * was delivered through `session/prompt` instead; the controller then relies on
 * the runtime echo rather than appending its own user message.
 */
export interface CommandExecutionResult {
  ok: boolean;
  text?: string;
  commandId?: string;
  sourceEventSeq?: number;
  fallbackPrompt?: boolean;
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

  /**
   * Optional capabilities. Every method is optional so a transport that lacks
   * the feature degrades instead of breaking activation.
   */
  renameSession?(sessionId: string, title: string): Promise<SessionRenameResult>;
  /** Forks the session and resolves with the new session id. */
  forkSession?(sessionId: string): Promise<string>;
  searchSessions?(query: string): Promise<SessionSearchHit[]>;
  /** Skills visible to the active session composition. */
  listSkills?(): Promise<SkillInfo[]>;
  /** Slash commands advertised for the active agent. */
  listCommands?(): Promise<CommandInfo[]>;
  executeCommand?(sessionId: string, line: string): Promise<CommandExecutionResult>;
}

export interface BackendFactoryOptions extends BackendLaunchOptions {
  emit: (event: import('../shared/protocol').AgentEvent) => void;
}
