/**
 * `Backend` implementation for the DSH web transport.
 *
 * Owns one {@link WebClient}, opens the `$events` notification stream plus a
 * `session/follow` stream for the active session, and translates every mux
 * item into {@link AgentEvent} values for the chat controller. Wire shapes are
 * mapped by the pure helpers in `wireMapping.ts`.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentPresetInfo,
  CommandInfo,
  ModelInfo,
  PermissionPreset,
  SessionSearchHit,
  SessionSummary,
  SkillInfo,
} from '../shared/protocol';
import { log } from '../log';
import type {
  Backend,
  BackendFactoryOptions,
  CommandExecutionResult,
  SendInput,
  SessionRenameResult,
} from './backend';
import { DshWebError, WebClient, type StreamHandle } from './webClient';
import {
  buildPromptContent,
  createWireContext,
  mapAgentPresetList,
  mapCommandList,
  mapFollowItem,
  mapModelCatalog,
  mapSessionList,
  mapSessionSearchResult,
  mapSkillList,
  parseModelId,
  resetTurnState,
  sessionEvent,
  type WireContext,
} from './wireMapping';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  if (error instanceof DshWebError) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/** Translate an approval option id into a DSH approval outcome. */
export function approvalOutcome(optionId: string): string {
  const normalized = optionId.trim().toLowerCase();
  if (normalized === 'rejected' || normalized === 'deny' || normalized === 'denied') {
    return 'rejected';
  }
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'cancel') {
    return 'cancelled';
  }
  if (normalized.startsWith('allowed') || normalized === 'allow' || normalized === 'approve') {
    return 'allowed-once';
  }
  return 'allowed-once';
}

export class WebBackend implements Backend {
  readonly kind = 'web';

  private readonly options: BackendFactoryOptions;
  private client: WebClient | undefined;
  private ctx: WireContext;
  private follow: StreamHandle | undefined;
  private eventStream: StreamHandle | undefined;
  private ready = false;
  private stopping = false;
  private models: ModelInfo[] = [];
  private presets: AgentPresetInfo[] = [];
  private sessions: SessionSummary[] = [];

  constructor(options: BackendFactoryOptions) {
    this.options = options;
    this.ctx = createWireContext({
      sessionId: null,
      messageId: randomUUID(),
      title: 'New session',
    });
  }

  async start(): Promise<void> {
    if (this.ready) return;

    const client = new WebClient({
      host: this.options.host,
      port: this.options.port,
      reuseExisting: this.options.reuseExisting,
      workspaceRoot: this.options.workspaceRoot,
      startTimeoutMs: this.options.startTimeoutMs,
      debug: this.options.debug,
      executable: this.options.executable,
      executableArgs: this.options.executableArgs,
      dshHome: this.options.dshHome,
      profile: this.options.profile,
      commandTimeoutMs: this.options.commandTimeoutMs,
      onExit: (info) => {
        this.ready = false;
        this.emit([{ type: 'backend-exit', ...info }]);
        if (info.error) this.notice('error', info.error);
      },
      onReconnect: () => {
        this.ready = true;
        this.ctx.attempt = undefined;
        this.notice('info', 'Reconnected to the agent runtime.');
      },
    });
    this.client = client;

    try {
      await client.start();
      this.ready = true;
      this.ctx.clientId = client.getClientId();
      this.openEvents();
      this.emit([{ type: 'backend-ready', detail: client.getBaseUrl() }, sessionEvent(this.ctx)]);
      void this.loadInitialState();
    } catch (error) {
      this.ready = false;
      this.notice('error', `Could not start the agent runtime: ${errorText(error)}`);
      this.emit([{ type: 'backend-exit', error: errorText(error) }]);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.ready = false;
    try {
      this.follow?.close();
      this.follow = undefined;
      this.eventStream?.close();
      this.eventStream = undefined;
      await this.client?.stop();
    } catch (error) {
      log('webBackend: error while stopping', errorText(error));
    }
  }

  isReady(): boolean {
    return this.ready && this.client?.isReady() === true;
  }

  async send(input: SendInput): Promise<void> {
    const client = this.requireClient();
    const sessionId = await this.ensureSession();
    resetTurnState(this.ctx, randomUUID());
    this.ctx.expectUserEcho = true;
    this.ctx.running = true;
    const requestId = randomUUID();
    const content = buildPromptContent(input);
    this.emit([sessionEvent(this.ctx)]);

    const timeoutMs = this.options.commandTimeoutMs ?? 120_000;
    try {
      await client.rpc(
        'session/prompt',
        {
          request: {
            requestId,
            sessionId,
            mode: 'queue',
            content,
          },
        },
        { timeoutMs },
      );
    } catch (error) {
      // A timed-out prompt must not poison the session: clear the optimistic
      // running flag and surface the failure, but keep the follow stream alive.
      this.ctx.expectUserEcho = false;
      this.ctx.running = false;
      this.notice('error', `Prompt failed: ${errorText(error)}`);
      this.emit([sessionEvent(this.ctx)]);
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    const client = this.requireClient();
    const sessionId = this.ctx.sessionId;
    if (!sessionId) {
      this.notice('warning', 'There is no active session to cancel.');
      return;
    }
    try {
      await client.rpc('session/cancel', { request: { sessionId } });
      this.notice('info', 'Cancellation requested.');
    } catch (error) {
      this.notice('error', `Could not cancel the turn: ${errorText(error)}`);
      throw error;
    }
  }

  async newSession(): Promise<void> {
    const client = this.requireClient();
    this.follow?.close();
    this.follow = undefined;
    let result: unknown;
    try {
      result = await client.rpc('session/create', {
        request: { cwd: this.options.workspaceRoot },
      });
    } catch (error) {
      this.notice('error', `Could not create a session: ${errorText(error)}`);
      throw error;
    }
    const sessionId = stringField(result, 'sessionId');
    if (!sessionId) {
      const message = 'session/create returned no sessionId.';
      this.notice('error', message);
      throw new DshWebError('session/create', message);
    }
    const agentPreset = stringField(result, 'agentPreset');
    this.resetContext(sessionId, agentPreset ?? null, 'New session');
    this.openFollow();
    this.emit([sessionEvent(this.ctx)]);
  }

  async switchSession(sessionId: string): Promise<void> {
    this.requireClient();
    this.follow?.close();
    this.follow = undefined;
    this.resetContext(sessionId, this.ctx.agentPreset, 'Loading session');
    this.openFollow();
    this.emit([sessionEvent(this.ctx)]);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const client = this.requireClient();
    const value = await client.rpc<unknown>('session/list', { _request: {} });
    const sessions = mapSessionList(value);
    this.sessions = sessions;
    for (const session of sessions) this.ctx.sessions.set(session.id, session);
    this.emit([{ type: 'sessions', sessions }]);
    return sessions;
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = this.requireClient();
    const value = await client.rpc<unknown>('session/modelCatalog', {});
    this.models = mapModelCatalog(value);
    this.applyDefaultModel(value);
    this.emit([{ type: 'models', models: this.models }, sessionEvent(this.ctx)]);
    return this.models;
  }

  async listAgentPresets(): Promise<AgentPresetInfo[]> {
    const client = this.requireClient();
    const value = await client.rpc<unknown>('agentPresets/list', {});
    this.presets = mapAgentPresetList(value);
    this.emit([{ type: 'agent-presets', presets: this.presets }]);
    return this.presets;
  }

  async setModel(modelId: string): Promise<void> {
    const client = this.requireClient();
    const parsed = parseModelId(modelId);
    if (!parsed) {
      const message = `"${modelId}" is not a <provider>:<model> id.`;
      this.notice('error', message);
      throw new DshWebError('model/invalid', message);
    }
    const sessionId = await this.ensureSession();
    const request: Record<string, unknown> = {
      sessionId,
      provider: parsed.provider,
      model: parsed.model,
    };
    if (this.ctx.reasoningEffort) request.reasoningEffort = this.ctx.reasoningEffort;
    try {
      const result = await client.rpc<unknown>('session/selectModel', { request });
      const selected = isRecord(result) && isRecord(result.selected) ? result.selected : undefined;
      const effort = stringField(selected, 'reasoningEffort');
      if (effort) this.ctx.reasoningEffort = effort;
      this.ctx.model = {
        id: modelId,
        provider: parsed.provider,
        model: parsed.model,
        label: parsed.model,
      };
      this.emit([sessionEvent(this.ctx)]);
    } catch (error) {
      this.notice('error', `Could not switch to ${modelId}: ${errorText(error)}`);
      throw error;
    }
  }

  async setPermission(preset: PermissionPreset): Promise<void> {
    const client = this.requireClient();
    try {
      const described = await client.rpc<unknown>('settings/describe', {});
      const revision = permissionRevision(described);
      await client.rpc('settings/update', {
        ns: 'permission',
        patch: { defaultPreset: preset },
        expectedRevision: revision,
      });
      this.ctx.permission = preset;
      this.emit([sessionEvent(this.ctx)]);
    } catch (error) {
      this.notice(
        'warning',
        `Could not persist the permission preset ${preset} (the runtime may not expose the permission namespace): ${errorText(
          error,
        )}`,
      );
      this.emit([sessionEvent(this.ctx)]);
    }
  }

  async setAgentPreset(presetId: string): Promise<void> {
    const client = this.requireClient();
    const sessionId = await this.ensureSession();
    try {
      await client.rpc('agentPresets/select', { agentId: sessionId, agentPreset: presetId });
      this.ctx.agentPreset = presetId;
      this.emit([sessionEvent(this.ctx)]);
    } catch (error) {
      this.notice('error', `Could not select agent preset ${presetId}: ${errorText(error)}`);
      throw error;
    }
  }

  async setReasoningEffort(effort: string): Promise<void> {
    const client = this.requireClient();
    if (!this.ctx.model) await this.listModels();
    const model = this.ctx.model;
    if (!model) {
      this.notice('warning', 'No model is selected yet, so the reasoning effort was not applied.');
      return;
    }
    const sessionId = await this.ensureSession();
    try {
      await client.rpc('session/selectModel', {
        request: {
          sessionId,
          provider: model.provider,
          model: model.model,
          reasoningEffort: effort,
        },
      });
      this.ctx.reasoningEffort = effort;
      this.emit([sessionEvent(this.ctx)]);
    } catch (error) {
      this.notice('error', `Could not set reasoning effort ${effort}: ${errorText(error)}`);
      throw error;
    }
  }

  async answerApproval(approvalId: string, optionId: string): Promise<void> {
    const client = this.requireClient();
    const pending = this.ctx.pendingApprovals.get(approvalId);
    if (!pending) {
      this.notice('warning', 'That approval is no longer pending.');
      this.emit([{ type: 'approval', request: null }]);
      return;
    }
    const clientId = pending.clientId || this.ctx.clientId || client.getClientId();
    const outcome = approvalOutcome(optionId);
    this.ctx.pendingApprovals.delete(approvalId);
    try {
      await client.rpc('$events/result', {
        clientId,
        eventId: pending.eventId,
        outcome: { kind: 'result', value: outcome },
      });
    } catch (error) {
      this.notice('error', `Could not deliver the approval decision: ${errorText(error)}`);
      this.emit([{ type: 'approval', request: null }]);
      throw error;
    }
    this.emit([{ type: 'approval', request: null }]);
  }

  // -- capability RPCs ----------------------------------------------------

  async renameSession(sessionId: string, title: string): Promise<SessionRenameResult> {
    const client = this.requireClient();
    const trimmed = title.trim();
    if (!trimmed) {
      throw new DshWebError('session/title-empty', 'A session title cannot be empty.');
    }
    try {
      const result = await client.rpc<unknown>('session/rename', {
        request: { sessionId, title: trimmed },
      });
      const renamed = stringField(result, 'title') ?? trimmed;
      const seq = isRecord(result) && typeof result.seq === 'number' ? result.seq : undefined;
      if (this.ctx.sessionId === sessionId) {
        this.ctx.title = renamed;
        this.emit([sessionEvent(this.ctx)]);
      }
      this.replaceKnownSessionTitle(sessionId, renamed);
      return { title: renamed, ...(seq !== undefined ? { seq } : {}) };
    } catch (error) {
      this.notice('error', `Could not rename the session: ${errorText(error)}`);
      throw error;
    }
  }

  async forkSession(sessionId: string): Promise<string> {
    const client = this.requireClient();
    try {
      const result = await client.rpc<unknown>('session/fork', { request: { sessionId } });
      const forked = stringField(result, 'sessionId');
      if (!forked) {
        throw new DshWebError('session/fork', 'session/fork returned no sessionId.');
      }
      return forked;
    } catch (error) {
      this.notice('error', `Could not fork the session: ${errorText(error)}`);
      throw error;
    }
  }

  async searchSessions(query: string): Promise<SessionSearchHit[]> {
    const client = this.requireClient();
    const trimmed = query.trim();
    if (!trimmed) return [];
    try {
      const value = await client.rpc<unknown>('session/search', { request: { query: trimmed } });
      return mapSessionSearchResult(value);
    } catch (error) {
      log('webBackend: session search unavailable', errorText(error));
      throw error;
    }
  }

  async listSkills(): Promise<SkillInfo[]> {
    const client = this.requireClient();
    const sessionId = this.ctx.sessionId;
    if (!sessionId) return [];
    const value = await client.rpc<unknown>('skills/list', { request: { sessionId } });
    return mapSkillList(value);
  }

  /**
   * `commands/list` takes a lookup parameter named `agent`; the gateway rewrites
   * it to `agentId` on the wire. The 0.2 gateway has been seen to reject both
   * shapes, so the documented alternatives are tried once and the capability
   * then degrades to an empty list instead of failing activation.
   */
  async listCommands(): Promise<CommandInfo[]> {
    const client = this.requireClient();
    const sessionId = this.ctx.sessionId;
    if (!sessionId) return [];
    const attemptArgs: Array<Record<string, unknown>> = [
      { agentId: sessionId },
      { agent: sessionId },
      { request: { agentId: sessionId } },
    ];
    let failure: unknown;
    for (const args of attemptArgs) {
      try {
        const value = await client.rpc<unknown>('commands/list', args);
        return mapCommandList(value);
      } catch (error) {
        failure = error;
        const code = error instanceof DshWebError ? error.code : '';
        if (code !== 'gateway/arguments-invalid') {
          break;
        }
      }
    }
    log('webBackend: commands/list unavailable', errorText(failure));
    return [];
  }

  async executeCommand(sessionId: string, line: string): Promise<CommandExecutionResult> {
    const client = this.requireClient();
    const trimmed = line.trim();
    if (!trimmed) {
      return { ok: false };
    }
    const target = sessionId || (await this.ensureSession());
    const timeoutMs = this.options.commandTimeoutMs ?? 120_000;
    try {
      const value = await client.rpc<unknown>(
        'commands/execute',
        { agentId: target, line: trimmed, submittedAttachments: [] },
        { timeoutMs },
      );
      const commandId = stringField(value, 'commandId');
      const result = isRecord(value) && isRecord(value.result) ? value.result : undefined;
      const kind = stringField(result, 'kind');
      const text = stringField(result, 'text');
      const sourceEventSeq = result && typeof result.sourceEventSeq === 'number' ? result.sourceEventSeq : undefined;
      // Only the documented fields are surfaced; unknown tool-shaped results
      // from newer runtimes are dropped instead of breaking the transcript.
      return {
        ok: kind !== 'error',
        ...(text !== undefined ? { text } : {}),
        ...(commandId !== undefined ? { commandId } : {}),
        ...(sourceEventSeq !== undefined ? { sourceEventSeq } : {}),
      };
    } catch (error) {
      log('webBackend: commands/execute failed, sending the line as a prompt instead', errorText(error));
      this.notice('info', `The runtime could not execute ${trimmed} directly; sending it as a prompt.`);
      await this.send({ text: trimmed, attachments: [] });
      return { ok: false, fallbackPrompt: true };
    }
  }

  private replaceKnownSessionTitle(sessionId: string, title: string): void {
    let changed = false;
    this.sessions = this.sessions.map((session) => {
      if (session.id !== sessionId || session.title === title) return session;
      changed = true;
      return { ...session, title };
    });
    const context = this.ctx.sessions.get(sessionId);
    if (context && context.title !== title) {
      this.ctx.sessions.set(sessionId, { ...context, title });
      changed = true;
    }
    if (changed) {
      this.emit([{ type: 'sessions', sessions: this.sessions }]);
    }
  }

  // -- internals ----------------------------------------------------------

  private requireClient(): WebClient {
    if (!this.client) {
      throw new DshWebError('not-started', 'The agent runtime is not started.');
    }
    return this.client;
  }

  private async ensureSession(): Promise<string> {
    if (this.ctx.sessionId) return this.ctx.sessionId;
    await this.newSession();
    if (!this.ctx.sessionId) {
      throw new DshWebError('session/missing', 'No session is available.');
    }
    return this.ctx.sessionId;
  }

  private resetContext(sessionId: string, agentPreset: string | null, title: string): void {
    const previous = this.ctx;
    this.ctx = createWireContext({
      sessionId,
      clientId: previous.clientId,
      messageId: randomUUID(),
      permission: previous.permission,
      model: previous.model,
      agentPreset: agentPreset ?? previous.agentPreset,
      reasoningEffort: previous.reasoningEffort,
      title,
    });
    for (const session of this.sessions) this.ctx.sessions.set(session.id, session);
  }

  private openEvents(): void {
    const client = this.requireClient();
    this.eventStream?.close();
    this.eventStream = client.openStream('$events', {}, {
      onItem: (value) => this.handleItem(value),
      onEnd: () => this.notice('warning', 'The agent event stream ended.'),
      onError: (error) => this.notice('error', `Event stream error: ${errorText(error)}`),
    });
  }

  private openFollow(): void {
    const client = this.requireClient();
    const sessionId = this.ctx.sessionId;
    if (!sessionId) return;
    this.follow?.close();
    this.follow = client.openStream(
      'session/follow',
      {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true,
        },
      },
      {
        onItem: (value) => this.handleItem(value),
        onEnd: () => this.notice('warning', 'The session stream ended; reconnecting will restore it.'),
        onError: (error) => this.notice('error', `Session stream error: ${errorText(error)}`),
      },
    );
  }

  private handleItem(value: unknown): void {
    try {
      const events = mapFollowItem(value, this.ctx);
      if (events.length > 0) this.emit(events);
    } catch (error) {
      log('webBackend: failed to map a mux item', errorText(error));
    }
    if (isRecord(value) && value.type === 'waterfall' && value.event === 'question/requested') {
      void this.cancelQuestion(value);
    }
  }

  /**
   * There is no chat UI for interactive questions yet. Cancel cleanly with an
   * empty answer set instead of leaving the turn blocked. Shape is INFERRED
   * from the reference implementation, so a rejection only produces a notice.
   */
  private async cancelQuestion(value: Record<string, unknown>): Promise<void> {
    const client = this.client;
    if (!client) return;
    const eventId = typeof value.eventId === 'string' ? value.eventId : '';
    const clientId = this.ctx.clientId || client.getClientId();
    if (!eventId || !clientId) return;
    try {
      await client.rpc('$events/result', {
        clientId,
        eventId,
        outcome: { kind: 'result', value: { answers: [] } },
      });
    } catch (error) {
      log('webBackend: could not cancel an interactive question', errorText(error));
    }
  }

  private async loadInitialState(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const catalog = await client.rpc<unknown>('session/modelCatalog', {});
      this.models = mapModelCatalog(catalog);
      this.applyDefaultModel(catalog);
      this.emit([{ type: 'models', models: this.models }, sessionEvent(this.ctx)]);
    } catch (error) {
      log('webBackend: model catalog unavailable', errorText(error));
    }
    try {
      const presets = await client.rpc<unknown>('agentPresets/list', {});
      this.presets = mapAgentPresetList(presets);
      this.emit([{ type: 'agent-presets', presets: this.presets }]);
    } catch (error) {
      log('webBackend: agent presets unavailable', errorText(error));
    }
    try {
      await this.listSessions();
    } catch (error) {
      log('webBackend: session list unavailable', errorText(error));
    }
  }

  private applyDefaultModel(catalog: unknown): void {
    if (!isRecord(catalog) || !isRecord(catalog.default)) return;
    const provider = stringField(catalog.default, 'provider');
    const model = stringField(catalog.default, 'model');
    if (!provider || !model) return;
    const id = `${provider}:${model}`;
    const known = this.models.find((entry) => entry.id === id);
    this.ctx.model = known ?? { id, provider, model, label: model };
  }

  private emit(events: AgentEvent[]): void {
    for (const event of events) {
      try {
        this.options.emit(event);
      } catch (error) {
        log('webBackend: event consumer threw', errorText(error));
      }
    }
  }

  private notice(level: 'info' | 'warning' | 'error', text: string): void {
    this.emit([{ type: 'notice', level, text }]);
  }
}

function permissionRevision(described: unknown): number {
  if (!isRecord(described) || !Array.isArray(described.namespaces)) return 0;
  for (const namespace of described.namespaces) {
    if (!isRecord(namespace) || namespace.ns !== 'permission') continue;
    const revision = namespace.revision;
    return typeof revision === 'number' ? revision : 0;
  }
  return 0;
}

/** Create the web transport backend for the chat controller. */
export function createWebBackend(options: BackendFactoryOptions): Backend {
  return new WebBackend(options);
}
