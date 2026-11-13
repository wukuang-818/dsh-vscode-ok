/**
 * Coalescing scheduler for host-to-webview messages.
 *
 * Streaming produces bursts of tiny messages (`delta`, `part`, `tool`, …).
 * Posting each one crosses the webview message boundary immediately, so the
 * scheduler buffers them and flushes once per animation frame sized interval.
 * Order is always preserved, and control messages flush the buffer first so
 * the webview never observes a state transition before the data it refers to.
 *
 * The module has no `vscode` dependency (timers are injectable) so the
 * behaviour can be unit tested with fake timers.
 */

/** Message types that are safe to defer by one frame. */
export const BATCHED_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'delta',
  'part',
  'tool',
  'notice',
  'toast',
  'state',
]);

/** Flush cadence: one frame at 60 Hz. */
export const DEFAULT_FLUSH_INTERVAL_MS = 16;

export interface PostBatcherOptions {
  /** Flush cadence in milliseconds (default {@link DEFAULT_FLUSH_INTERVAL_MS}). */
  flushIntervalMs?: number;
  /** Predicate deciding whether a message may be deferred. */
  isBatched?: (type: string) => boolean;
  /** Timer hook, injectable for tests. */
  schedule?: (callback: () => void, ms: number) => unknown;
  /** Timer cancellation hook, injectable for tests. */
  cancel?: (handle: unknown) => void;
}

interface TypedMessage {
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

/**
 * Merge `next` into the tail of the queue when the two are contiguous parts of
 * the same logical update. Returns `undefined` when they must stay separate.
 */
export function mergeBatchedMessages<T extends TypedMessage>(
  previous: T | undefined,
  next: T,
): T | undefined {
  if (!previous || previous.type !== next.type) {
    return undefined;
  }
  if (next.type === 'delta') {
    const previousId = stringField(previous, 'messageId');
    const nextId = stringField(next, 'messageId');
    const previousIndex = numberField(previous, 'index');
    const nextIndex = numberField(next, 'index');
    const previousText = stringField(previous, 'text');
    const nextText = stringField(next, 'text');
    if (
      previousId !== undefined &&
      previousId === nextId &&
      previousIndex !== undefined &&
      previousIndex === nextIndex &&
      previousText !== undefined &&
      nextText !== undefined
    ) {
      return { ...next, text: previousText + nextText } as T;
    }
    return undefined;
  }
  if (next.type === 'state') {
    const previousPatch = (previous as unknown as { patch?: unknown }).patch;
    const nextPatch = (next as unknown as { patch?: unknown }).patch;
    if (!isRecord(previousPatch) || !isRecord(nextPatch)) {
      return undefined;
    }
    // Only merge patches that touch disjoint keys; a shared key would need a
    // deep merge and a wrong merge would silently drop state.
    const disjoint = Object.keys(nextPatch).every((key) => !(key in previousPatch));
    if (!disjoint) {
      return undefined;
    }
    return { ...next, patch: { ...previousPatch, ...nextPatch } } as T;
  }
  return undefined;
}

/**
 * Buffers deferrable messages and flushes them on a timer. Immediate message
 * types are delivered without buffering, after any pending buffer is flushed.
 */
export class PostBatcher<T extends TypedMessage = TypedMessage> {
  private readonly sink: (message: T) => void;
  private readonly flushIntervalMs: number;
  private readonly isBatched: (type: string) => boolean;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  private queue: T[] = [];
  private timer: unknown;
  private disposed = false;

  constructor(sink: (message: T) => void, options: PostBatcherOptions = {}) {
    this.sink = sink;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.isBatched = options.isBatched ?? ((type) => BATCHED_MESSAGE_TYPES.has(type));
    this.schedule =
      options.schedule ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        // Timers must not keep the extension host alive on their own.
        (handle as unknown as { unref?: () => void }).unref?.();
        return handle;
      });
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Number of messages waiting for the next flush. */
  get size(): number {
    return this.queue.length;
  }

  /** Buffer or deliver one message, preserving insertion order. */
  enqueue(message: T): void {
    if (this.disposed) {
      return;
    }
    if (!this.isBatched(message.type)) {
      this.flush();
      this.deliver(message);
      return;
    }
    const merged = mergeBatchedMessages(this.queue[this.queue.length - 1], message);
    if (merged !== undefined) {
      this.queue[this.queue.length - 1] = merged;
    } else {
      this.queue.push(message);
    }
    this.arm();
  }

  /** Deliver every buffered message in order and stop the timer. */
  flush(): void {
    this.clearTimer();
    if (this.queue.length === 0) {
      return;
    }
    const pending = this.queue;
    this.queue = [];
    for (const message of pending) {
      this.deliver(message);
    }
  }

  /** Flush what is already queued, then ignore later messages. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.flush();
    this.disposed = true;
  }

  private deliver(message: T): void {
    try {
      this.sink(message);
    } catch {
      // A broken sink must not wedge the scheduler; the caller logs elsewhere.
    }
  }

  private arm(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer === undefined) {
      return;
    }
    const handle = this.timer;
    this.timer = undefined;
    this.cancel(handle);
  }
}
