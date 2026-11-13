/**
 * Unit tests for the pure wire-mapping layer (`src/dsh/wireMapping.ts`).
 *
 * Fixtures mirror the shapes captured in `docs/recon/dsh-web-api.md`: mux
 * `session/follow` items (`snapshot`, `assistant-stream`, `waterfall`, `emit`,
 * `event`) and durable `session/events` envelopes. Nothing here touches
 * vscode, the network or timers, so every case is a plain function call.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent, Attachment } from '../src/shared/protocol';
import {
  buildPromptText,
  createWireContext,
  diffCounts,
  fileDiffFromMeta,
  mapAgentPresetList,
  mapFollowItem,
  mapModelCatalog,
  mapSessionEvent,
  mapSessionList,
  parseModelId,
  resetTurnState,
  sessionEvent,
  toolTitle,
} from '../src/dsh/wireMapping';
import type { SessionEventEnvelope, WireContext } from '../src/dsh/wireMapping';

type EventOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

function eventTypes(events: AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

function only<T extends AgentEvent['type']>(events: AgentEvent[], type: T): EventOf<T>[] {
  return events.filter((event): event is EventOf<T> => event.type === type);
}

function first<T extends AgentEvent['type']>(events: AgentEvent[], type: T): EventOf<T> {
  const found = only(events, type)[0];
  if (!found) {
    throw new Error(`expected a ${type} event, got ${eventTypes(events).join(', ') || 'none'}`);
  }
  return found;
}

/** Durable `session/events` envelope as it arrives on `session/follow`. */
function envelope(type: string, seq: number, data: unknown, time = seq): SessionEventEnvelope {
  return { type, seq, time, data };
}

/** `assistant-stream` chunk frame, shaped like a live capture. */
function chunkFrame(
  attemptId: string,
  chunk: Record<string, unknown>,
  index = 0,
): Record<string, unknown> {
  return {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId,
      revision: index + 42,
      index,
      time: 1794553420859,
      chunk,
    },
  };
}

/** `session/follow` snapshot item with the live projection set. */
function snapshotItem(values: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: {
      version: 4,
      id: 'session-test',
      createdAt: 1,
      isSeeded: false,
      agentPreset: 'standard',
    },
    projections: {
      asOfSeq: 1,
      values: {
        title: 'Test session',
        sessionStats: {},
        contextPressure: undefined,
        todos: [],
        plan: undefined,
        permissions: { currentValue: 'workspace-write' },
        modelSelection: {
          lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' },
          next: undefined,
        },
        tokenUsage: {
          uncachedInputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        ...values,
      },
    },
  };
}

function newContext(init: Partial<Parameters<typeof createWireContext>[0]> = {}): WireContext {
  return createWireContext({ sessionId: 'session-test', messageId: 'msg-1', ...init });
}

describe('wire context', () => {
  it('starts from the documented defaults', () => {
    const ctx = createWireContext({ sessionId: 'session-test', messageId: 'msg-1' });
    expect(ctx.sessionId).toBe('session-test');
    expect(ctx.messageId).toBe('msg-1');
    expect(ctx.clientId).toBe('');
    expect(ctx.baselineSeq).toBe(-1);
    expect(ctx.running).toBe(false);
    expect(ctx.title).toBe('New session');
    expect(ctx.permission).toBe('workspace-write');
    expect(ctx.model).toBeNull();
    expect(ctx.agentPreset).toBeNull();
    expect(ctx.reasoningEffort).toBeUndefined();
    expect(ctx.usage).toBeUndefined();
    expect(ctx.messageStarted).toBe(false);
    expect(ctx.expectUserEcho).toBe(false);
    expect(ctx.partIndex).toBe(0);
    expect(ctx.turn).toBe(0);
    expect(ctx.step).toBe(0);
    expect(ctx.attempt).toBeUndefined();
    expect(ctx.tools.size).toBe(0);
    expect(ctx.toolParts.size).toBe(0);
    expect(ctx.pendingApprovals.size).toBe(0);
    expect(ctx.sessions.size).toBe(0);
  });

  it('honours every supplied init field', () => {
    const ctx = newContext({
      clientId: 'client-9',
      permission: 'danger-full-access',
      title: 'Preset title',
      agentPreset: 'standard',
      reasoningEffort: 'high',
      model: {
        id: 'deepseek-official:deepseek-flash',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        label: 'DeepSeek V4 Flash',
      },
    });
    expect(ctx.clientId).toBe('client-9');
    expect(ctx.permission).toBe('danger-full-access');
    expect(ctx.title).toBe('Preset title');
    expect(ctx.agentPreset).toBe('standard');
    expect(ctx.reasoningEffort).toBe('high');
    expect(ctx.model?.id).toBe('deepseek-official:deepseek-flash');
  });

  it('omits unset optional session fields and includes them once known', () => {
    const bare = newContext();
    const bareEvent = sessionEvent(bare);
    expect(bareEvent.type).toBe('session');
    const bareSession = first([bareEvent], 'session').session;
    expect(bareSession).toEqual({
      id: 'session-test',
      title: 'New session',
      model: null,
      permission: 'workspace-write',
      agentPreset: null,
      running: false,
    });
    expect('reasoningEffort' in bareSession).toBe(false);
    expect('usage' in bareSession).toBe(false);

    const full = newContext({ reasoningEffort: 'low' });
    full.usage = { inputTokens: 3, outputTokens: 4 };
    full.running = true;
    const fullSession = first([sessionEvent(full)], 'session').session;
    expect(fullSession.reasoningEffort).toBe('low');
    expect(fullSession.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(fullSession.running).toBe(true);
  });

  it('resets turn state but keeps session level bookkeeping', () => {
    const ctx = newContext();
    ctx.title = 'Kept';
    ctx.usage = { inputTokens: 1 };
    ctx.tools.set('call_1', {
      id: 'call_1',
      name: 'pwsh',
      title: 'pwsh',
      status: 'done',
      startedAt: 1,
    });
    ctx.sessions.set('other', { id: 'other', title: 'Other' });
    ctx.messageStarted = true;
    ctx.partIndex = 4;
    ctx.turn = 2;
    ctx.step = 3;
    ctx.attempt = { attemptId: 'live', live: true, blocks: new Map() };

    resetTurnState(ctx, 'msg-2');

    expect(ctx.messageId).toBe('msg-2');
    expect(ctx.messageStarted).toBe(false);
    expect(ctx.partIndex).toBe(0);
    expect(ctx.turn).toBe(0);
    expect(ctx.step).toBe(0);
    expect(ctx.attempt).toBeUndefined();
    expect(ctx.title).toBe('Kept');
    expect(ctx.usage).toEqual({ inputTokens: 1 });
    expect(ctx.tools.has('call_1')).toBe(true);
    expect(ctx.sessions.has('other')).toBe(true);
  });
});

describe('snapshot items', () => {
  it('adopts projections, baseline seq, model and usage', () => {
    const ctx = newContext();
    const events = mapFollowItem(snapshotItem(), ctx);

    expect(eventTypes(events)).toEqual(['session']);
    expect(ctx.sessionId).toBe('session-test');
    expect(ctx.baselineSeq).toBe(1);
    expect(ctx.title).toBe('Test session');
    expect(ctx.agentPreset).toBe('standard');
    expect(ctx.permission).toBe('workspace-write');
    expect(ctx.model).toEqual({
      id: 'deepseek-official:deepseek-flash',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      label: 'deepseek-flash',
    });
    // cacheReadTokens folds into inputTokens unless the runtime reports uncached input.
    expect(ctx.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
    const session = first(events, 'session').session;
    expect(session.model?.id).toBe('deepseek-official:deepseek-flash');
    expect(session.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedTokens: 0 });

    // a queued `next` selection wins over `lastUsed`, in object and string form
    const nextCtx = newContext();
    mapFollowItem(
      snapshotItem({
        modelSelection: {
          lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' },
          next: {
            provider: 'deepseek-official',
            model: 'deepseek-v4',
            reasoningEffort: 'high',
          },
        },
      }),
      nextCtx,
    );
    expect(nextCtx.model).toEqual({
      id: 'deepseek-official:deepseek-v4',
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      label: 'deepseek-v4',
    });
    expect(nextCtx.reasoningEffort).toBe('high');
    expect(first([sessionEvent(nextCtx)], 'session').session.reasoningEffort).toBe('high');

    const stringCtx = newContext();
    mapFollowItem(snapshotItem({ modelSelection: { next: 'openai:gpt-5' } }), stringCtx);
    expect(stringCtx.model?.id).toBe('openai:gpt-5');
    expect(stringCtx.model?.provider).toBe('openai');

    // the snapshot seq is the replay floor: at-or-below frames are dropped
    const replayCtx = newContext();
    mapFollowItem(snapshotItem(), replayCtx);
    expect(replayCtx.baselineSeq).toBe(1);
    const replay = envelope('user/message', 1, {
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    });
    expect(mapSessionEvent(replay, replayCtx)).toEqual([]);

    const fresh = mapSessionEvent(
      envelope('session/title', 2, { title: 'After baseline' }),
      replayCtx,
    );
    expect(eventTypes(fresh)).toEqual(['session']);
    expect(replayCtx.title).toBe('After baseline');
  });

  it('drops the in-flight attempt and emits known sessions after a reconnect', () => {
    const ctx = newContext();
    mapFollowItem(
      { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-1', revision: 1 } },
      ctx,
    );
    expect(ctx.attempt?.attemptId).toBe('attempt-1');

    mapFollowItem(
      {
        type: 'emit',
        event: 'api-session/added',
        args: [
          {
            sessionId: 'other',
            updatedAt: 5,
            running: false,
            cwd: 'D:/y',
            projections: { values: { title: 'Other session' } },
          },
        ],
      },
      ctx,
    );

    const events = mapFollowItem(snapshotItem(), ctx);
    expect(eventTypes(events)).toEqual(['session', 'sessions']);
    expect(ctx.attempt).toBeUndefined();
    expect(only(events, 'sessions')[0]?.sessions).toEqual([
      { id: 'other', title: 'Other session', cwd: 'D:/y', updatedAt: 5, running: false },
    ]);
  });

  it('prefers modelSelection.next, including the string form', () => {
    const ctx = newContext();
    mapFollowItem(
      snapshotItem({
        modelSelection: {
          lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' },
          next: {
            provider: 'deepseek-official',
            model: 'deepseek-v4',
            reasoningEffort: 'high',
          },
        },
      }),
      ctx,
    );
    expect(ctx.model).toEqual({
      id: 'deepseek-official:deepseek-v4',
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      label: 'deepseek-v4',
    });
    expect(ctx.reasoningEffort).toBe('high');
    expect(first([sessionEvent(ctx)], 'session').session.reasoningEffort).toBe('high');

    const stringCtx = newContext();
    mapFollowItem(snapshotItem({ modelSelection: { next: 'openai:gpt-5' } }), stringCtx);
    expect(stringCtx.model?.id).toBe('openai:gpt-5');
    expect(stringCtx.model?.provider).toBe('openai');
  });
});

describe('assistant live stream frames', () => {
  it('opens the message and a part on block-start, then streams deltas', () => {
    const ctx = newContext();
    const started = mapFollowItem(
      chunkFrame('session-test:1', { type: 'block-start', index: 1, blockType: 'text' }),
      ctx,
    );
    expect(eventTypes(started)).toEqual(['message-start', 'part']);
    const message = first(started, 'message-start').message;
    expect(message.id).toBe('msg-1');
    expect(message.role).toBe('assistant');
    expect(message.status).toBe('streaming');
    expect(message.parts).toEqual([]);
    expect(typeof message.createdAt).toBe('number');

    const part = first(started, 'part');
    expect(part.messageId).toBe('msg-1');
    // attempt block index 1 maps onto the first chat part index 0
    expect(part.index).toBe(0);
    expect(part.part).toEqual({ type: 'text', text: '' });

    const delta = mapFollowItem(
      chunkFrame('session-test:1', { type: 'text-delta', index: 1, text: 'p' }, 1),
      ctx,
    );
    expect(delta).toEqual([{ type: 'delta', messageId: 'msg-1', index: 0, text: 'p' }]);
  });

  it('creates the reasoning part lazily from a reasoning-delta', () => {
    const ctx = newContext();
    const events = mapFollowItem(
      chunkFrame('session-test:1', { type: 'reasoning-delta', index: 0, text: 'thinking' }),
      ctx,
    );
    expect(eventTypes(events)).toEqual(['message-start', 'part', 'delta']);
    expect(first(events, 'part').part).toEqual({ type: 'reasoning', text: '' });
    expect(first(events, 'delta')).toEqual({
      type: 'delta',
      messageId: 'msg-1',
      index: 0,
      text: 'thinking',
    });
  });

  it('registers a pending tool from tool-call-delta exactly once', () => {
    const ctx = newContext();
    const chunk = {
      type: 'tool-call-delta',
      index: 2,
      id: 'call_1',
      name: 'pwsh',
      argumentsDelta: '{"command":',
    };
    const events = mapFollowItem(chunkFrame('session-test:1', chunk), ctx);
    expect(eventTypes(events)).toEqual(['message-start', 'part', 'tool']);
    expect(first(events, 'part').part).toEqual({ type: 'tool', toolId: 'call_1' });
    const tool = first(events, 'tool').tool;
    expect(tool).toMatchObject({
      id: 'call_1',
      name: 'pwsh',
      status: 'pending',
      input: '{"command":',
      title: 'pwsh: {"command":',
    });

    // Duplicate frames are dropped wholesale, not just deduplicated per part.
    expect(mapFollowItem(chunkFrame('session-test:1', chunk, 1), ctx)).toEqual([]);
  });

  it('replaces the same part index on block-end instead of appending', () => {
    const ctx = newContext();
    mapFollowItem(
      chunkFrame('session-test:1', { type: 'block-start', index: 0, blockType: 'text' }),
      ctx,
    );
    mapFollowItem(chunkFrame('session-test:1', { type: 'text-delta', index: 0, text: 'par' }, 1), ctx);

    const events = mapFollowItem(
      chunkFrame('session-test:1', { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } }, 2),
      ctx,
    );
    expect(eventTypes(events)).toEqual(['part']);
    const part = first(events, 'part');
    expect(part.index).toBe(0);
    expect(part.part).toEqual({ type: 'text', text: 'partial' });
    // the authoritative block-end reuses the part, so no second index is allocated
    expect(ctx.partIndex).toBe(1);
  });

  it('turns a block-end tool-call into a running tool with its input', () => {
    const ctx = newContext();
    const events = mapFollowItem(
      chunkFrame('session-test:1', {
        type: 'block-end',
        index: 2,
        block: { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"echo hi"}' },
      }),
      ctx,
    );
    expect(eventTypes(events)).toEqual(['message-start', 'part', 'tool']);
    expect(first(events, 'tool').tool).toMatchObject({
      id: 'call_1',
      name: 'pwsh',
      status: 'running',
      input: '{"command":"echo hi"}',
      title: 'pwsh: echo hi',
    });
  });

  it('merges usage chunks and surfaces finish failures as warnings', () => {
    const ctx = newContext();
    const usage = mapFollowItem(
      chunkFrame('session-test:1', {
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
      ctx,
    );
    expect(eventTypes(usage)).toEqual(['session']);
    // totalTokens/cacheWriteTokens have no SessionUsage slot and are dropped.
    expect(first(usage, 'session').session.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cachedTokens: 0,
    });

    expect(
      mapFollowItem(chunkFrame('session-test:1', { type: 'finish', reason: { kind: 'stop' } }), ctx),
    ).toEqual([]);
    expect(
      mapFollowItem(
        chunkFrame(
          'session-test:1',
          { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } },
          1,
        ),
        ctx,
      ),
    ).toEqual([{ type: 'notice', level: 'warning', text: 'boom' }]);
  });

  it('records the live attempt on start and reports abandoned ends', () => {
    const ctx = newContext();
    const started = mapFollowItem(
      {
        type: 'assistant-stream',
        frame: { type: 'start', attemptId: 'session-test:1', revision: 1, turn: 3, step: 2 },
      },
      ctx,
    );
    expect(started).toEqual([]);
    expect(ctx.attempt?.attemptId).toBe('session-test:1');
    expect(ctx.attempt?.live).toBe(true);
    expect(ctx.turn).toBe(3);
    expect(ctx.step).toBe(2);

    expect(
      mapFollowItem(
        {
          type: 'assistant-stream',
          frame: {
            type: 'end',
            attemptId: 'session-test:1',
            revision: 50,
            index: 9,
            outcome: { kind: 'abandoned' },
          },
        },
        ctx,
      ),
    ).toEqual([
      { type: 'notice', level: 'info', text: 'The live assistant stream was interrupted.' },
    ]);

    expect(
      mapFollowItem(
        {
          type: 'assistant-stream',
          frame: {
            type: 'end',
            attemptId: 'session-test:1',
            revision: 50,
            index: 9,
            outcome: { kind: 'committed', eventType: 'assistant/message', seq: 19 },
          },
        },
        ctx,
      ),
    ).toEqual([]);
  });
});

describe('durable session events', () => {
  it('reconciles a committed assistant message onto live block indices', () => {
    const ctx = newContext({ messageId: 'msg-9' });
    mapFollowItem(
      {
        type: 'assistant-stream',
        frame: { type: 'start', attemptId: 'session-test:1', revision: 1, turn: 1, step: 1 },
      },
      ctx,
    );
    mapFollowItem(
      chunkFrame('session-test:1', { type: 'block-start', index: 0, blockType: 'text' }),
      ctx,
    );

    const events = mapSessionEvent(
      envelope('assistant/message', 2, {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'reasoning', text: 'because' },
          ],
          id: 'm1',
        },
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
      ctx,
    );

    expect(eventTypes(events)).toEqual(['part', 'part', 'part', 'session']);
    const parts = only(events, 'part');
    expect(parts.map((part) => part.index)).toEqual([0, 1, 1]);
    expect(parts.map((part) => part.part)).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: '' },
      { type: 'reasoning', text: 'because' },
    ]);
    expect(first(events, 'session').session.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it('rebuilds parts from scratch when no attempt is in flight', () => {
    const ctx = newContext();
    const events = mapSessionEvent(
      envelope('assistant/message', 2, {
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      ctx,
    );
    expect(eventTypes(events)).toEqual(['message-start', 'part', 'part']);
    const parts = only(events, 'part');
    // the first part opens the slot, the second fills it with the final text
    expect(parts.map((part) => part.index)).toEqual([0, 0]);
    expect(parts.map((part) => part.part)).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('replays assistant/attempt only while no live attempt is mounted', () => {
    const ctx = newContext();
    const events = mapSessionEvent(
      envelope('assistant/attempt', 2, {
        stream: [
          { type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'hi' } },
        ],
      }),
      ctx,
    );
    expect(eventTypes(events)).toEqual(['message-start', 'part', 'delta']);
    expect(ctx.attempt?.attemptId).toBe('durable-2');
    expect(ctx.attempt?.live).toBe(false);

    const live = newContext();
    mapFollowItem(
      { type: 'assistant-stream', frame: { type: 'start', attemptId: 'live-1', revision: 1 } },
      live,
    );
    expect(
      mapSessionEvent(
        envelope('assistant/attempt', 3, {
          stream: [{ type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } }],
        }),
        live,
      ),
    ).toEqual([]);
  });

  it('creates a tool from tool/call and settles it from tool/result', () => {
    const ctx = newContext();
    const started = mapSessionEvent(
      envelope('tool/call', 3, {
        turn: 1,
        step: 1,
        callId: 'call_1',
        name: 'pwsh',
        arguments: '{"command":"echo hi"}',
      }),
      ctx,
    );
    expect(eventTypes(started)).toEqual(['message-start', 'part', 'tool']);
    expect(first(started, 'tool').tool).toMatchObject({
      id: 'call_1',
      status: 'running',
      startedAt: 3,
      title: 'pwsh: echo hi',
    });

    const settled = mapSessionEvent(
      envelope('tool/result', 4, {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'hi' }],
          isError: false,
          id: 't1',
        },
        meta: {
          path: 'D:/x/note.txt',
          diffs: [{ path: 'D:/x/note.txt', oldText: 'hello', newText: 'hello2' }],
        },
      }),
      ctx,
    );
    expect(eventTypes(settled)).toEqual(['tool']);
    expect(first(settled, 'tool').tool).toMatchObject({
      id: 'call_1',
      status: 'done',
      output: 'hi',
      startedAt: 3,
      endedAt: 4,
      diff: {
        path: 'D:/x/note.txt',
        added: 1,
        removed: 1,
        oldText: 'hello',
        newText: 'hello2',
      },
    });

    // error and done share a status rank, so a late failure can still win
    const failed = mapSessionEvent(
      envelope('tool/result', 5, {
        message: {
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'Error: nope' }],
          isError: true,
        },
      }),
      ctx,
    );
    expect(first(failed, 'tool').tool).toMatchObject({
      status: 'error',
      output: 'Error: nope',
      endedAt: 5,
      startedAt: 3,
    });
  });

  it('advances turn counters and closes the message from turn/end', () => {
    const doneCtx = newContext();
    expect(mapSessionEvent(envelope('turn/start', 0, { turn: 4 }), doneCtx)).toEqual([]);
    expect(doneCtx.turn).toBe(4);
    expect(doneCtx.step).toBe(0);
    expect(mapSessionEvent(envelope('step/start', 1, { step: 2 }), doneCtx)).toEqual([]);
    expect(doneCtx.step).toBe(2);
    const done = mapSessionEvent(
      envelope('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
      doneCtx,
    );
    expect(eventTypes(done)).toEqual(['message-start', 'message-status', 'session']);
    expect(first(done, 'message-status')).toMatchObject({ messageId: 'msg-1', status: 'done' });
    expect(first(done, 'session').session.running).toBe(false);

    const failedCtx = newContext();
    const failed = mapSessionEvent(
      envelope('turn/end', 5, {
        turn: 1,
        reason: { kind: 'error', error: { message: 'boom', code: 'X' } },
      }),
      failedCtx,
    );
    expect(first(failed, 'message-status')).toMatchObject({ status: 'error', error: 'boom' });

    const aborted = mapSessionEvent(
      envelope('turn/end', 6, { turn: 1, reason: { kind: 'canceled' } }),
      failedCtx,
    );
    // the message was already opened, so only status + session are re-emitted
    expect(eventTypes(aborted)).toEqual(['message-status', 'session']);
    expect(first(aborted, 'message-status').status).toBe('aborted');

    // missing counters fall back to a simple increment
    const implicit = newContext();
    mapSessionEvent(envelope('turn/start', 0, {}), implicit);
    expect(implicit.turn).toBe(1);
    mapSessionEvent(envelope('step/start', 1, {}), implicit);
    expect(implicit.step).toBe(1);
  });

  it('clears pending approvals when the turn ends', () => {
    const ctx = newContext();
    mapFollowItem(
      {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'evt-1',
        agentId: 'session-test',
        request: { toolName: 'edit', callId: 'call_1', reason: 'escalate sandbox' },
      },
      ctx,
    );
    expect(ctx.pendingApprovals.size).toBe(1);

    const events = mapSessionEvent(
      envelope('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
      ctx,
    );
    expect(eventTypes(events)).toEqual(['message-start', 'message-status', 'approval', 'session']);
    expect(first(events, 'approval').request).toBeNull();
    expect(ctx.pendingApprovals.size).toBe(0);
  });

  it('renders a user echo once, unless a prompt already rendered it optimistically', () => {
    const ctx = newContext();
    const echoed = mapSessionEvent(
      envelope('user/message', 1, {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'text', text: ' there' },
        ],
        source: { kind: 'user' },
        role: 'user',
        id: 'u1',
      }),
      ctx,
    );
    expect(eventTypes(echoed)).toEqual(['message-start']);
    const message = first(echoed, 'message-start').message;
    expect(message).toMatchObject({
      id: 'user-1',
      role: 'user',
      createdAt: 1,
      status: 'done',
      parts: [{ type: 'text', text: 'hi there' }],
    });

    ctx.expectUserEcho = true;
    const suppressed = mapSessionEvent(
      envelope('user/message', 2, {
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      }),
      ctx,
    );
    expect(suppressed).toEqual([]);
    expect(ctx.expectUserEcho).toBe(false);

    // the flag is one-shot: the next echo renders again
    expect(
      eventTypes(
        mapSessionEvent(
          envelope('user/message', 3, {
            content: [{ type: 'text', text: 'again' }],
            source: { kind: 'user' },
          }),
          ctx,
        ),
      ),
    ).toEqual(['message-start']);

    expect(
      mapSessionEvent(
        envelope('user/message', 4, {
          content: [{ type: 'text', text: 'runtime context' }],
          source: { kind: 'runtime-context' },
        }),
        ctx,
      ),
    ).toEqual([]);
  });

  it('renders todo/write as a finished pseudo tool call', () => {
    const ctx = newContext();
    const events = mapSessionEvent(
      envelope('todo/write', 7, {
        todos: [
          { content: 'write tests', status: 'pending' },
          { title: 'run suite', status: 'in_progress' },
        ],
      }),
      ctx,
    );
    expect(eventTypes(events)).toEqual(['tool']);
    expect(first(events, 'tool').tool).toEqual({
      id: 'todo-7',
      name: 'todo',
      title: 'Plan updated',
      status: 'done',
      output: '- [pending] write tests\n- [in_progress] run suite',
      startedAt: 7,
      endedAt: 7,
    });
    expect(mapSessionEvent(envelope('todo/write', 8, { todos: 'nope' }), ctx)).toEqual([]);
  });

  it('applies permission, sandbox and title updates through session events', () => {
    const ctx = newContext();
    const preset = mapSessionEvent(envelope('permission/preset', 1, { preset: 'read-only' }), ctx);
    expect(eventTypes(preset)).toEqual(['session']);
    expect(ctx.permission).toBe('read-only');

    expect(
      mapSessionEvent(envelope('permission/preset', 2, { preset: 'not-a-preset' }), ctx),
    ).toEqual([]);

    const sandbox = mapSessionEvent(
      envelope('sandbox/mode', 3, { mode: 'danger-full-access' }),
      ctx,
    );
    expect(eventTypes(sandbox)).toEqual(['session']);
    expect(ctx.permission).toBe('danger-full-access');

    const titled = mapSessionEvent(envelope('session/title', 4, { title: 'Renamed' }), ctx);
    expect(eventTypes(titled)).toEqual(['session']);
    expect(ctx.title).toBe('Renamed');
    expect(first(titled, 'session').session.title).toBe('Renamed');
    expect(mapSessionEvent(envelope('session/title', 5, { title: '' }), ctx)).toEqual([]);
  });
});

describe('approval flows', () => {
  it('marks a tool awaiting approval from approval/asked but does not register it as pending', () => {
    const ctx = newContext();
    const asked = mapSessionEvent(
      envelope('approval/asked', 3, { callId: 'call_1', toolName: 'edit', id: 'ap-1' }),
      ctx,
    );
    expect(eventTypes(asked)).toEqual(['tool']);
    expect(first(asked, 'tool').tool).toMatchObject({
      id: 'call_1',
      status: 'awaiting-approval',
      approvalId: 'ap-1',
    });
    // only the waterfall path populates pendingApprovals
    expect(ctx.pendingApprovals.size).toBe(0);

    const decided = mapSessionEvent(
      envelope('approval/decided', 4, { id: 'ap-1', outcome: 'rejected' }),
      ctx,
    );
    expect(eventTypes(decided)).toEqual(['approval']);
    expect(first(decided, 'approval').request).toBeNull();
    // with no pending entry the tool is never settled by approval/decided
    expect(ctx.tools.get('call_1')?.status).toBe('awaiting-approval');
  });

  it('maps a waterfall approval request and settles the tool when allowed', () => {
    const ctx = newContext();
    ctx.clientId = 'client-9';
    const events = mapFollowItem(
      {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'evt-1',
        agentId: 'session-test',
        request: {
          toolName: 'edit',
          callId: 'call_1',
          reason: 'escalate sandbox',
          displayReason: { en: 'Edit file' },
        },
      },
      ctx,
    );

    expect(eventTypes(events)).toEqual(['tool', 'approval']);
    expect(first(events, 'tool').tool).toMatchObject({
      id: 'call_1',
      name: 'edit',
      status: 'awaiting-approval',
      approvalId: 'evt-1',
    });

    const approval = first(events, 'approval').request;
    expect(approval).toMatchObject({
      id: 'evt-1',
      toolCallId: 'call_1',
      toolName: 'edit',
      title: 'Approve edit',
      // displayReason.en wins over the raw reason
      detail: 'Edit file',
    });
    expect(approval?.options).toEqual([
      { id: 'allowed-once', label: 'Allow once' },
      { id: 'rejected', label: 'Deny', danger: true },
    ]);
    expect(ctx.pendingApprovals.get('evt-1')).toMatchObject({
      approvalId: 'evt-1',
      callId: 'call_1',
      agentId: 'session-test',
      clientId: 'client-9',
    });

    const decided = mapSessionEvent(
      envelope('approval/decided', 6, { id: 'evt-1', outcome: 'allowed-once' }),
      ctx,
    );
    expect(eventTypes(decided)).toEqual(['approval', 'tool']);
    expect(first(decided, 'approval').request).toBeNull();
    expect(first(decided, 'tool').tool.status).toBe('running');
    expect(ctx.pendingApprovals.size).toBe(0);

    // without a displayReason the raw reason becomes the detail, and a rejection cancels
    const rawCtx = newContext();
    const raw = mapFollowItem(
      {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'evt-2',
        agentId: 'session-test',
        request: { toolName: 'pwsh', callId: 'call_2', reason: 'escalate sandbox' },
      },
      rawCtx,
    );
    expect(first(raw, 'approval').request?.detail).toBe('escalate sandbox');

    const rejected = mapSessionEvent(
      envelope('approval/decided', 7, { id: 'evt-2', outcome: 'rejected' }),
      rawCtx,
    );
    expect(first(rejected, 'tool').tool.status).toBe('canceled');

    // interactive questions are unsupported, so they register and warn
    const question = mapFollowItem(
      {
        type: 'waterfall',
        event: 'question/requested',
        eventId: 'q-1',
        agentId: 'session-test',
      },
      rawCtx,
    );
    expect(eventTypes(question)).toEqual(['notice']);
    expect(first(question, 'notice').level).toBe('warning');
    expect(first(question, 'notice').text).toContain('interactive questions are not supported');
    expect(rawCtx.pendingApprovals.has('q-1')).toBe(true);

    expect(
      mapFollowItem({ type: 'waterfall', event: 'approval/resolved', eventId: 'evt-2' }, rawCtx),
    ).toEqual([{ type: 'approval', request: null }]);
  });
});

describe('session/follow items', () => {
  it('projects api-session notifications into summaries and notices', () => {
    const ctx = newContext();
    const added = mapFollowItem(
      {
        type: 'emit',
        event: 'api-session/added',
        args: [
          {
            sessionId: 'other',
            updatedAt: 5,
            running: true,
            cwd: 'D:/y',
            projections: { values: { title: 'Other session' } },
          },
        ],
      },
      ctx,
    );
    expect(eventTypes(added)).toEqual(['sessions']);
    expect(only(added, 'sessions')[0]?.sessions).toEqual([
      { id: 'other', title: 'Other session', cwd: 'D:/y', updatedAt: 5, running: true },
    ]);

    const status = mapFollowItem(
      { type: 'emit', event: 'api-session/status', args: ['session-test', true] },
      ctx,
    );
    expect(eventTypes(status)).toEqual(['sessions', 'session']);
    expect(ctx.running).toBe(true);

    const self = mapFollowItem(
      {
        type: 'emit',
        event: 'api-session/added',
        args: [
          {
            sessionId: 'session-test',
            updatedAt: 6,
            projections: { values: { title: 'Renamed by emit' } },
          },
        ],
      },
      ctx,
    );
    expect(eventTypes(self)).toEqual(['sessions', 'session']);
    expect(ctx.title).toBe('Renamed by emit');
    expect(ctx.running).toBe(false);

    expect(
      mapFollowItem({ type: 'emit', event: 'api-session/activity', args: ['other', 9] }, ctx),
    ).toEqual([]);
    expect(
      mapFollowItem({ type: 'emit', event: 'api-session/error', args: ['session-test', 'it broke'] }, ctx),
    ).toEqual([{ type: 'notice', level: 'error', text: 'it broke' }]);
    expect(
      mapFollowItem({ type: 'emit', event: 'api-session/error', args: ['other', 'nope'] }, ctx),
    ).toEqual([]);
  });

  it('forwards wrapped event items into the durable mapper', () => {
    const ctx = newContext();
    expect(mapFollowItem({ type: 'ready', clientId: 'client-9' }, ctx)).toEqual([]);
    expect(ctx.clientId).toBe('client-9');
    expect(mapFollowItem({ type: 'unknown-item' }, ctx)).toEqual([]);

    const events = mapFollowItem(
      { type: 'event', event: { type: 'session/title', seq: 9, time: 9, data: { title: 'From event' } } },
      ctx,
    );
    expect(eventTypes(events)).toEqual(['session']);
    expect(ctx.title).toBe('From event');
    expect(mapFollowItem({ type: 'event' }, ctx)).toEqual([]);
  });
});

describe('pure helpers', () => {
  it('builds tool titles from the documented argument keys', () => {
    expect(toolTitle('pwsh', '{"command":"echo hi","description":"List files"}')).toBe(
      'pwsh: List files',
    );
    expect(toolTitle('edit', '{"file_path":"D:/x/a.ts"}')).toBe('edit: D:/x/a.ts');
    expect(toolTitle('search', '{"query":"wire mapping"}')).toBe('search: wire mapping');
    expect(toolTitle('pwsh', 'not json')).toBe('pwsh: not json');
    expect(toolTitle('pwsh', '')).toBe('pwsh');
    expect(toolTitle('pwsh', '{"command":"echo   hi\\nthere"}')).toBe('pwsh: echo hi there');
    const long = toolTitle('pwsh', `{"command":"${'x'.repeat(300)}"}`);
    expect(long).toBe(`pwsh: ${'x'.repeat(120)}`);
  });

  it('counts line level additions and removals', () => {
    expect(diffCounts('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
    expect(diffCounts('a\nb', 'a\nc')).toEqual({ added: 1, removed: 1 });
    expect(diffCounts('a\r\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    expect(diffCounts('', '')).toEqual({ added: 0, removed: 0 });

    // Above 40k line pairs the LCS matrix is skipped and the raw lengths are used.
    const identical = Array.from({ length: 201 }, (_, index) => `line ${index}`).join('\n');
    expect(diffCounts(identical, identical)).toEqual({ added: 201, removed: 201 });
  });

  it('reads diffs out of tool result meta', () => {
    expect(
      fileDiffFromMeta({
        path: 'D:/x/note.txt',
        diffs: [{ path: 'D:/x/note.txt', oldText: 'hello', newText: 'hello2' }],
      }),
    ).toEqual({
      path: 'D:/x/note.txt',
      added: 1,
      removed: 1,
      oldText: 'hello',
      newText: 'hello2',
    });

    expect(
      fileDiffFromMeta({ path: 'D:/x/new.txt', diffs: [{ patch: '@@ -0,0 +1 @@' }] }),
    ).toEqual({ path: 'D:/x/new.txt', added: 0, removed: 0, patch: '@@ -0,0 +1 @@' });

    expect(fileDiffFromMeta({ path: 'D:/x/new.txt', operation: 'create' })).toEqual({
      path: 'D:/x/new.txt',
      added: 0,
      removed: 0,
    });

    expect(fileDiffFromMeta({ path: 'D:/x/read.txt' })).toBeUndefined();
    expect(fileDiffFromMeta('nope')).toBeUndefined();
    expect(fileDiffFromMeta(null)).toBeUndefined();
  });

  it('composes the prompt text from attachments', () => {
    expect(buildPromptText({ text: 'hello', attachments: [] })).toBe('hello');

    const selection: Attachment = {
      kind: 'selection',
      label: 'src/a.ts:1-2',
      text: 'const a = 1;',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 2,
    };
    // every block is joined with a blank line, including inside the code fence
    expect(buildPromptText({ text: 'hello', attachments: [selection] })).toBe(
      'hello\n\n[selection: src/a.ts:1-2] src/a.ts (lines 1-2)\n\n```\n\nconst a = 1;\n\n```',
    );

    const image: Attachment = { kind: 'image', label: 'shot.png' };
    expect(buildPromptText({ text: 'look', attachments: [image] })).toBe(
      'look\n\n[image: shot.png] (image data is not forwarded by this transport)',
    );

    const file: Attachment = { kind: 'file', label: 'doc.ts', path: 'D:/x/doc.ts' };
    // the empty text block is filtered, so the note starts the prompt
    expect(buildPromptText({ text: '', attachments: [file] })).toBe(
      '[file: doc.ts] D:/x/doc.ts',
    );
  });

  it('parses composite model ids on the first colon only', () => {
    expect(parseModelId('deepseek-official:deepseek-flash')).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    });
    expect(parseModelId('openai:gpt-5:mini')).toEqual({ provider: 'openai', model: 'gpt-5:mini' });
    expect(parseModelId(':model')).toBeUndefined();
    expect(parseModelId('model:')).toBeUndefined();
    expect(parseModelId('model')).toBeUndefined();
  });

  it('flattens the model catalog', () => {
    const catalog = {
      default: { provider: 'deepseek-official', model: 'deepseek-flash' },
      routableProviders: ['deepseek-official'],
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [
            {
              id: 'deepseek-flash',
              name: 'DeepSeek V4 Flash',
              description: 'fast',
              reasoning: {
                efforts: [{ id: 'low', name: 'Low' }],
                defaultEffort: 'low',
              },
            },
          ],
        },
      ],
      failures: [],
    };
    expect(mapModelCatalog(catalog)).toEqual([
      {
        id: 'deepseek-official:deepseek-flash',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        label: 'DeepSeek V4 Flash',
        description: 'fast',
        reasoningEfforts: ['low'],
        defaultReasoningEffort: 'low',
        vendor: 'DeepSeek',
      },
    ]);
    expect(mapModelCatalog({ groups: [{ id: 'p', models: [{ name: 'no id' }, 'nope'] }] })).toEqual(
      [],
    );
    expect(mapModelCatalog(null)).toEqual([]);
  });

  it('normalizes agent preset lists', () => {
    expect(mapAgentPresetList({ presets: [{ id: 'standard', isDefault: true }] })).toEqual([
      { id: 'standard', name: 'Standard' },
    ]);
    expect(mapAgentPresetList({ presets: [{ id: 'code-review' }] })).toEqual([
      { id: 'code-review', name: 'Code Review' },
    ]);
    expect(
      mapAgentPresetList({ presets: [{ id: 'x', name: 'Explicit', description: 'desc' }] }),
    ).toEqual([{ id: 'x', name: 'Explicit', description: 'desc' }]);
    expect(mapAgentPresetList({})).toEqual([]);
  });

  it('summarizes the session list', () => {
    const list = {
      items: [
        {
          sessionId: 'session-test',
          updatedAt: 1,
          agentAvailable: true,
          running: false,
          blank: false,
          cwd: 'D:/x',
          projections: {
            kind: 'sequenced',
            asOfSeq: 1,
            values: {
              title: 'T',
              sessionStats: {},
              modelSelection: {
                lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' },
              },
            },
          },
        },
      ],
    };
    expect(mapSessionList(list)).toEqual([
      { id: 'session-test', title: 'T', cwd: 'D:/x', updatedAt: 1, running: false },
    ]);
    expect(mapSessionList({ items: [{ sessionId: 'a' }, { title: 'no id' }] })).toEqual([
      { id: 'a', title: 'Untitled session', running: false },
    ]);
    expect(mapSessionList(undefined)).toEqual([]);
  });
});
