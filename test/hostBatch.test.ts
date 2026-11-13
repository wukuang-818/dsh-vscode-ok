import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLUSH_INTERVAL_MS, PostBatcher, type PostBatcherOptions } from '../src/hostBatch';

interface TestMessage {
  type: string;
  [key: string]: unknown;
}

function delta(messageId: string, index: number, text: string): TestMessage {
  return { type: 'delta', messageId, index, text };
}

function collect(options: PostBatcherOptions = {}) {
  const messages: TestMessage[] = [];
  const batcher = new PostBatcher<TestMessage>((message) => messages.push(message), options);
  return { batcher, messages };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PostBatcher batching', () => {
  it('holds streaming messages until the 16 ms flush', () => {
    const { batcher, messages } = collect();
    batcher.enqueue(delta('m1', 0, 'po'));

    expect(messages).toHaveLength(0);
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS - 1);
    expect(messages).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(DEFAULT_FLUSH_INTERVAL_MS).toBe(16);
    expect(messages).toEqual([delta('m1', 0, 'po')]);
  });

  it('coalesces consecutive deltas of the same part', () => {
    const { batcher, messages } = collect();
    batcher.enqueue(delta('m1', 0, 'po'));
    batcher.enqueue(delta('m1', 0, 'ng'));
    batcher.enqueue(delta('m1', 0, '!'));
    expect(batcher.size).toBe(1);

    batcher.flush();
    expect(messages).toEqual([delta('m1', 0, 'pong!')]);
  });

  it('does not coalesce deltas that target different parts or messages', () => {
    const { batcher, messages } = collect();
    batcher.enqueue(delta('m1', 0, 'a'));
    batcher.enqueue(delta('m1', 1, 'b'));
    batcher.enqueue(delta('m2', 1, 'c'));
    batcher.flush();
    expect(messages).toHaveLength(3);
  });

  it('does not coalesce deltas separated by another message', () => {
    const { batcher, messages } = collect();
    batcher.enqueue(delta('m1', 0, 'a'));
    batcher.enqueue({ type: 'part', messageId: 'm1', index: 0, part: { type: 'text', text: 'a' } });
    batcher.enqueue(delta('m1', 0, 'b'));
    batcher.flush();
    expect(messages.map((message) => message.type)).toEqual(['delta', 'part', 'delta']);
    expect(messages[0]).toEqual(delta('m1', 0, 'a'));
    expect(messages[2]).toEqual(delta('m1', 0, 'b'));
  });

  it('preserves insertion order across every batched type', () => {
    const { batcher, messages } = collect();
    const queued: TestMessage[] = [
      delta('m1', 0, 'x'),
      { type: 'part', messageId: 'm1', index: 0, part: { type: 'text', text: 'x' } },
      { type: 'tool', tool: { id: 't1' } },
      { type: 'notice', level: 'info', text: 'hello' },
      { type: 'toast', level: 'warning', text: 'careful' },
      { type: 'state', patch: { models: [] } },
    ];
    for (const message of queued) batcher.enqueue(message);
    batcher.flush();
    expect(messages).toEqual(queued);
  });

  it('merges state patches only when their keys are disjoint', () => {
    const { batcher, messages } = collect();
    batcher.enqueue({ type: 'state', patch: { config: { a: 1 } } });
    batcher.enqueue({ type: 'state', patch: { models: [] } });
    batcher.enqueue({ type: 'state', patch: { config: { b: 2 } } });
    batcher.flush();
    expect(messages).toEqual([
      { type: 'state', patch: { config: { a: 1 }, models: [] } },
      { type: 'state', patch: { config: { b: 2 } } },
    ]);
  });

  it('never drops messages', () => {
    const { batcher, messages } = collect();
    for (let index = 0; index < 200; index += 1) {
      batcher.enqueue(delta('m1', index, String(index)));
    }
    batcher.flush();
    expect(messages).toHaveLength(200);
    expect(messages[199]).toEqual(delta('m1', 199, '199'));
  });
});

describe('PostBatcher immediate messages', () => {
  it('flushes the pending batch before an immediate message', () => {
    const { batcher, messages } = collect();
    batcher.enqueue(delta('m1', 0, 'a'));
    batcher.enqueue({ type: 'session', session: { id: 's1' } });

    // Both are visible synchronously: the delta first, then the session.
    expect(messages.map((message) => message.type)).toEqual(['delta', 'session']);
  });

  it('posts immediate messages without scheduling a timer', () => {
    const { batcher, messages } = collect();
    batcher.enqueue({ type: 'init', state: {} });
    expect(messages).toEqual([{ type: 'init', state: {} }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats every documented control message as immediate', () => {
    const immediate = [
      'init',
      'clear',
      'backend',
      'session',
      'sessions',
      'models',
      'agent-presets',
      'files',
      'commands',
      'skills',
      'search-results',
      'approval',
      'message',
      'message-status',
      'focus-composer',
      'composer',
    ];
    const { batcher, messages } = collect();
    for (const type of immediate) {
      batcher.enqueue({ type });
    }
    expect(messages).toHaveLength(immediate.length);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PostBatcher lifecycle', () => {
  it('flushes pending messages on dispose and drops the timer', () => {
    const { batcher, messages } = collect();
    batcher.enqueue(delta('m1', 0, 'a'));
    batcher.dispose();

    expect(messages).toEqual([delta('m1', 0, 'a')]);
    vi.advanceTimersByTime(100);
    expect(messages).toHaveLength(1);
  });

  it('ignores messages enqueued after dispose', () => {
    const { batcher, messages } = collect();
    batcher.dispose();
    batcher.enqueue(delta('m1', 0, 'later'));
    vi.advanceTimersByTime(100);
    expect(messages).toHaveLength(0);
  });

  it('is idempotent on repeated dispose', () => {
    const { batcher, messages } = collect();
    batcher.enqueue(delta('m1', 0, 'a'));
    batcher.dispose();
    batcher.dispose();
    expect(messages).toHaveLength(1);
  });

  it('honours an injected interval and timer hooks', () => {
    const scheduled: number[] = [];
    const cancelled: unknown[] = [];
    const messages: TestMessage[] = [];
    const batcher = new PostBatcher<TestMessage>((message) => messages.push(message), {
      flushIntervalMs: 50,
      schedule: (callback, ms) => {
        scheduled.push(ms);
        setTimeout(callback, ms);
        return 'handle';
      },
      cancel: (handle) => {
        cancelled.push(handle);
      },
    });

    batcher.enqueue(delta('m1', 0, 'a'));
    expect(scheduled).toEqual([50]);
    vi.advanceTimersByTime(50);
    expect(messages).toHaveLength(1);
    batcher.dispose();
    expect(cancelled).toEqual([]);
  });
});
