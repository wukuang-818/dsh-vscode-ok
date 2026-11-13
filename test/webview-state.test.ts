/**
 * Reducer tests for the DSH chat webview.
 *
 * The reducer is deliberately DOM free, so these run in the default `node`
 * vitest environment (see vitest.config.ts).
 */

import { describe, expect, it } from 'vitest';
import type {
  ApprovalRequest,
  ChatMessage,
  ChatState,
  DeepPartial,
  HostMessage,
  ToolCall,
} from '../src/shared/protocol';
import {
  createInitialState,
  emptyChatState,
  mergeChatPatch,
  mergeDeep,
  reduceApp,
  selectApprovalChoices,
  selectCanSend,
  selectDismissOption,
  type AppState,
} from '../src/webview/state';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeChat(overrides: DeepPartial<ChatState> = {}): ChatState {
  return mergeDeep(emptyChatState(), overrides);
}

function assistantMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    createdAt: 0,
    parts: [],
    status: 'streaming',
    ...overrides,
  };
}

function userMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'user',
    createdAt: 0,
    parts: [],
    status: 'done',
    ...overrides,
  };
}

function toolCall(overrides: Partial<ToolCall> & { id: string }): ToolCall {
  return {
    name: 'read_file',
    title: 'Read file',
    status: 'running',
    startedAt: 0,
    ...overrides,
  };
}

function host(state: AppState, message: HostMessage): AppState {
  return reduceApp(state, { type: 'host', message });
}

function init(chat: ChatState): AppState {
  return host(createInitialState(), { type: 'init', state: chat });
}

function currentChat(state: AppState): ChatState {
  const chat = state.chat;
  if (!chat) throw new Error('expected an initialised chat state');
  return chat;
}

/* ------------------------------------------------------------------ */
/* State patch merge                                                   */
/* ------------------------------------------------------------------ */

describe('deep merge', () => {
  it('merges nested objects and replaces arrays wholesale', () => {
    const base = { a: { b: 1, c: 2 }, list: [1, 2, 3] };
    const merged = mergeDeep(base, { a: { c: 9 }, list: [4] });
    expect(merged.a).toEqual({ b: 1, c: 9 });
    expect(merged.list).toEqual([4]);
  });

  it('keeps base values for undefined patch fields', () => {
    const chat = makeChat({ workspace: { name: 'repo', cwd: '/repo' } });
    const patched = mergeChatPatch(chat, { workspace: { name: 'renamed' } });
    expect(patched.workspace).toEqual({ name: 'renamed', cwd: '/repo', isSingleFolder: false });
  });

  it('applies a state patch without concatenating messages', () => {
    const first = userMessage({ id: 'm1', parts: [{ type: 'text', text: 'hi' }] });
    const second = userMessage({ id: 'm2', parts: [{ type: 'text', text: 'again' }] });
    const state = init(makeChat({ messages: [first] }));
    const patched = host(state, { type: 'state', patch: { messages: [second] } });
    expect(currentChat(patched).messages).toHaveLength(1);
    expect(currentChat(patched).messages[0]?.id).toBe('m2');
  });

  it('deep patches session and config while preserving untouched fields', () => {
    const state = init(makeChat({ session: { permission: 'danger-full-access', running: false } }));
    const patched = host(state, {
      type: 'state',
      patch: { session: { title: 'Investigate bug' }, config: { confirmBeforeSend: false } },
    });
    const chat = currentChat(patched);
    expect(chat.session.title).toBe('Investigate bug');
    expect(chat.session.permission).toBe('danger-full-access');
    expect(chat.session.running).toBe(false);
    expect(chat.config).toEqual({ includeDiagnostics: true, confirmBeforeSend: false });
  });
});

/* ------------------------------------------------------------------ */
/* init / clear / sessions                                             */
/* ------------------------------------------------------------------ */

describe('init and clear', () => {
  it('init replaces the previous state instead of merging into it', () => {
    const state = init(
      makeChat({
        workspace: { name: 'first', cwd: '/first' },
        messages: [userMessage({ id: 'm1', parts: [{ type: 'text', text: 'old' }] })],
      }),
    );
    const replaced = host(state, {
      type: 'init',
      state: makeChat({ workspace: { name: 'second', cwd: '/second' } }),
    });
    expect(currentChat(replaced).workspace.name).toBe('second');
    expect(currentChat(replaced).messages).toEqual([]);
  });

  it('clear empties the transcript and the tool map', () => {
    const state = init(
      makeChat({
        messages: [userMessage({ id: 'm1', parts: [{ type: 'text', text: 'hello' }] })],
        tools: { t1: toolCall({ id: 't1', status: 'done' }) },
      }),
    );
    const cleared = host(state, { type: 'clear' });
    expect(currentChat(cleared).messages).toEqual([]);
    expect(currentChat(cleared).tools).toEqual({});
  });

  it('sessions messages replace the list instead of appending', () => {
    const state = init(makeChat({ sessions: [{ id: 'a', title: 'A' }] }));
    const two = host(state, {
      type: 'sessions',
      sessions: [
        { id: 'a', title: 'A', running: true },
        { id: 'b', title: 'B' },
      ],
    });
    expect(currentChat(two).sessions).toHaveLength(2);
    const one = host(two, { type: 'sessions', sessions: [{ id: 'b', title: 'B' }] });
    expect(currentChat(one).sessions).toHaveLength(1);
    expect(currentChat(one).sessions[0]?.id).toBe('b');
  });
});

/* ------------------------------------------------------------------ */
/* Messages, parts, deltas                                             */
/* ------------------------------------------------------------------ */

describe('messages and parts', () => {
  it('appends deltas to an existing text part', () => {
    const state = init(
      makeChat({
        messages: [
          assistantMessage({ id: 'a1', parts: [{ type: 'text', text: 'Hel' }] }),
        ],
      }),
    );
    const first = host(state, { type: 'delta', messageId: 'a1', index: 0, text: 'lo' });
    const second = host(first, { type: 'delta', messageId: 'a1', index: 0, text: ' world' });
    expect(currentChat(second).messages[0]?.parts[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('ignores a delta for a missing message', () => {
    const state = init(makeChat({ messages: [assistantMessage({ id: 'a1' })] }));
    const before = currentChat(state);
    const after = host(state, { type: 'delta', messageId: 'missing', index: 0, text: 'x' });
    expect(currentChat(after)).toBe(before);
    expect(currentChat(after).messages).toHaveLength(1);
  });

  it('ignores a delta for a missing part or a non-text part', () => {
    const state = init(
      makeChat({
        messages: [
          assistantMessage({
            id: 'a1',
            parts: [{ type: 'tool', toolId: 't1' }],
          }),
        ],
      }),
    );
    const missingPart = host(state, { type: 'delta', messageId: 'a1', index: 3, text: 'x' });
    expect(currentChat(missingPart).messages[0]?.parts).toHaveLength(1);
    const toolPart = host(state, { type: 'delta', messageId: 'a1', index: 0, text: 'x' });
    expect(currentChat(toolPart).messages[0]?.parts[0]).toEqual({ type: 'tool', toolId: 't1' });
  });

  it('upserts parts by index', () => {
    const state = init(makeChat({ messages: [assistantMessage({ id: 'a1' })] }));
    const appended = host(state, {
      type: 'part',
      messageId: 'a1',
      index: 0,
      part: { type: 'text', text: 'first' },
    });
    expect(currentChat(appended).messages[0]?.parts).toHaveLength(1);
    const replaced = host(appended, {
      type: 'part',
      messageId: 'a1',
      index: 0,
      part: { type: 'text', text: 'second' },
    });
    expect(currentChat(replaced).messages[0]?.parts).toHaveLength(1);
    expect(currentChat(replaced).messages[0]?.parts[0]).toEqual({ type: 'text', text: 'second' });
  });

  it('clamps an out-of-range part index and appends deltas to the appended part', () => {
    const state = init(makeChat({ messages: [assistantMessage({ id: 'a1' })] }));
    const withPart = host(state, {
      type: 'part',
      messageId: 'a1',
      index: 1,
      part: { type: 'reasoning', text: 'think' },
    });
    expect(currentChat(withPart).messages[0]?.parts).toHaveLength(1);
    const withDelta = host(withPart, {
      type: 'delta',
      messageId: 'a1',
      index: 0,
      text: 'ing',
    });
    const parts = currentChat(withDelta).messages[0]?.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'reasoning', text: 'thinking' });
  });

  it('transitions message status and carries the error text', () => {
    const state = init(makeChat({ messages: [assistantMessage({ id: 'a1' })] }));
    const done = host(state, { type: 'message-status', messageId: 'a1', status: 'done' });
    expect(currentChat(done).messages[0]?.status).toBe('done');
    expect(currentChat(done).messages[0]?.error).toBeUndefined();

    const failed = host(done, {
      type: 'message-status',
      messageId: 'a1',
      status: 'error',
      error: 'backend crashed',
    });
    expect(currentChat(failed).messages[0]?.status).toBe('error');
    expect(currentChat(failed).messages[0]?.error).toBe('backend crashed');

    const aborted = host(failed, {
      type: 'message-status',
      messageId: 'a1',
      status: 'aborted',
    });
    expect(currentChat(aborted).messages[0]?.status).toBe('aborted');
    expect(currentChat(aborted).messages[0]?.error).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

describe('tool calls', () => {
  it('stores a tool and adds its part to the streaming assistant message', () => {
    const state = init(makeChat({ messages: [assistantMessage({ id: 'a1' })] }));
    const withTool = host(state, { type: 'tool', tool: toolCall({ id: 't1' }) });
    const chat = currentChat(withTool);
    expect(chat.tools['t1']?.status).toBe('running');
    expect(chat.messages[0]?.parts).toEqual([{ type: 'tool', toolId: 't1' }]);
  });

  it('updates a tool in place without duplicating its part', () => {
    const state = init(makeChat({ messages: [assistantMessage({ id: 'a1' })] }));
    const running = host(state, { type: 'tool', tool: toolCall({ id: 't1' }) });
    const finished = host(running, {
      type: 'tool',
      tool: toolCall({
        id: 't1',
        status: 'done',
        output: 'file contents',
        diff: { path: 'src/a.ts', added: 3, removed: 1 },
      }),
    });
    const chat = currentChat(finished);
    expect(chat.tools['t1']?.status).toBe('done');
    expect(chat.tools['t1']?.diff?.added).toBe(3);
    expect(chat.messages[0]?.parts).toHaveLength(1);
  });

  it('deduplicates an explicit tool part that follows the tool event', () => {
    const state = init(makeChat({ messages: [assistantMessage({ id: 'a1' })] }));
    const withTool = host(state, { type: 'tool', tool: toolCall({ id: 't1' }) });
    const withPart = host(withTool, {
      type: 'part',
      messageId: 'a1',
      index: 0,
      part: { type: 'tool', toolId: 't1' },
    });
    expect(currentChat(withPart).messages[0]?.parts).toEqual([{ type: 'tool', toolId: 't1' }]);
  });

  it('does not invent a message when no assistant message is streaming', () => {
    const state = init(makeChat({ messages: [] }));
    const withTool = host(state, { type: 'tool', tool: toolCall({ id: 't1' }) });
    const chat = currentChat(withTool);
    expect(chat.tools['t1']).toBeDefined();
    expect(chat.messages).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Webview-local state                                                 */
/* ------------------------------------------------------------------ */

describe('webview-local state', () => {
  it('pushes and dismisses toasts', () => {
    const state = host(createInitialState(), { type: 'toast', level: 'warning', text: 'careful' });
    expect(state.toasts).toHaveLength(1);
    const toastId = state.toasts[0]?.id;
    if (toastId === undefined) throw new Error('expected a toast id');
    const dismissed = reduceApp(state, { type: 'dismiss-toast', id: toastId });
    expect(dismissed.toasts).toHaveLength(0);
  });

  it('records composer fills and focus requests with monotonic counters', () => {
    const filled = host(createInitialState(), {
      type: 'composer',
      text: 'explain this',
      attachments: [{ kind: 'file', label: 'src/a.ts', path: 'src/a.ts' }],
    });
    expect(filled.composerSeq).toBe(1);
    expect(filled.composerFill?.text).toBe('explain this');
    expect(filled.composerFill?.attachments).toHaveLength(1);

    const refilled = host(filled, { type: 'composer', text: 'again' });
    expect(refilled.composerSeq).toBe(2);
    expect(refilled.composerFill?.attachments).toBeUndefined();

    const focused = host(refilled, { type: 'focus-composer' });
    expect(focused.focusRequest).toBe(1);
  });

  it('closes the approval modal on answer', () => {
    const request: ApprovalRequest = {
      id: 'ap1',
      toolName: 'shell',
      title: 'Run command?',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'reject', label: 'Reject' },
      ],
    };
    const opened = host(createInitialState(), { type: 'approval', request });
    expect(opened.approval?.id).toBe('ap1');
    const answered = reduceApp(opened, { type: 'approval-answer' });
    expect(answered.approval).toBeNull();
  });

  it('ignores unknown host message types', () => {
    const state = init(makeChat());
    const unknown = { type: 'not-a-host-message' } as unknown as HostMessage;
    expect(reduceApp(state, { type: 'host', message: unknown })).toBe(state);
  });
});

/* ------------------------------------------------------------------ */
/* Selectors and approval helpers                                      */
/* ------------------------------------------------------------------ */

describe('selectors', () => {
  it('only allows sending with a ready backend and no running turn', () => {
    const stopped = init(makeChat({ backend: { status: 'stopped' } }));
    expect(selectCanSend(stopped)).toBe(false);
    const ready = init(makeChat({ backend: { status: 'ready' } }));
    expect(selectCanSend(ready)).toBe(true);
    const busy = init(makeChat({ backend: { status: 'ready' }, session: { running: true } }));
    expect(selectCanSend(busy)).toBe(false);
  });

  it('splits approval options into approve/reject choices', () => {
    const request: ApprovalRequest = {
      id: 'ap1',
      toolName: 'shell',
      title: 'Run command?',
      options: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'allow-always', label: 'Always allow' },
        { id: 'deny', label: 'Deny', danger: true },
      ],
    };
    const choices = selectApprovalChoices(request);
    expect(choices?.approve.id).toBe('allow-once');
    expect(choices?.reject?.id).toBe('deny');
    expect(choices?.reject?.danger).toBe(true);
    expect(selectDismissOption(request)).toBe('deny');
  });

  it('falls back to the last option and then to the default for dismissal', () => {
    const twoOptions: ApprovalRequest = {
      id: 'ap2',
      toolName: 'write',
      title: 'Overwrite file?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No, keep the file' },
      ],
    };
    expect(selectApprovalChoices(twoOptions)?.reject?.id).toBe('no');

    const single: ApprovalRequest = {
      id: 'ap3',
      toolName: 'read',
      title: 'Read file?',
      options: [{ id: 'ok', label: 'OK' }],
    };
    expect(selectApprovalChoices(single)).toEqual({
      approve: { id: 'ok', label: 'OK', danger: false },
      reject: null,
    });
    expect(selectDismissOption(single)).toBe('ok');
  });
});
