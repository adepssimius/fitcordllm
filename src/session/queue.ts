/**
 * Per-thread serialisation with coalescing.
 *
 * Two reasons a thread must run one turn at a time:
 *  - two concurrent `resume`s of the same SDK session would race the transcript;
 *  - turns are the scarce resource, and three rapid messages should cost one
 *    turn, not three.
 *
 * A message arriving mid-run is buffered, not rejected and not interrupted:
 * rejecting is unhelpful because the human cannot see that a run is in flight,
 * and interrupting throws away a turn that has already been paid for.
 */

export interface Queued<T> {
  readonly item: T;
  readonly at: number;
}

export type Drain<T> = (head: T, coalesced: readonly T[]) => Promise<void>;

export interface EnqueueResult {
  /** false when the buffer is full and the message was dropped. */
  readonly accepted: boolean;
  /** true when a run was already in flight, so this was buffered. */
  readonly queued: boolean;
  readonly depth: number;
}

interface Lane<T> {
  running: boolean;
  buffer: Queued<T>[];
}

export class ThreadQueue<T> {
  private readonly lanes = new Map<string, Lane<T>>();

  constructor(
    private readonly drain: Drain<T>,
    private readonly opts: { maxPending: number; onError?: (key: string, e: unknown) => void },
  ) {}

  depth(key: string): number {
    return this.lanes.get(key)?.buffer.length ?? 0;
  }

  isRunning(key: string): boolean {
    return this.lanes.get(key)?.running === true;
  }

  get activeLanes(): number {
    return [...this.lanes.values()].filter((l) => l.running).length;
  }

  enqueue(key: string, item: T, now = Date.now()): EnqueueResult {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { running: false, buffer: [] };
      this.lanes.set(key, lane);
    }

    if (lane.buffer.length >= this.opts.maxPending) {
      return { accepted: false, queued: true, depth: lane.buffer.length };
    }

    lane.buffer.push({ item, at: now });
    const queued = lane.running;
    if (!lane.running) void this.pump(key);
    return { accepted: true, queued, depth: lane.buffer.length };
  }

  private async pump(key: string): Promise<void> {
    const lane = this.lanes.get(key);
    if (!lane || lane.running) return;
    lane.running = true;

    try {
      while (lane.buffer.length > 0) {
        // Take everything buffered so far as ONE turn: the head is the prompt,
        // the rest are follow-ups the human sent before we could reply.
        const batch = lane.buffer.splice(0, lane.buffer.length);
        const head = batch[0]!;
        const rest = batch.slice(1).map((q) => q.item);
        try {
          await this.drain(head.item, rest);
        } catch (e) {
          this.opts.onError?.(key, e);
        }
      }
    } finally {
      lane.running = false;
      if (lane.buffer.length === 0) this.lanes.delete(key);
      else void this.pump(key); // raced: something arrived as we finished
    }
  }
}
