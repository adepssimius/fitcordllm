/**
 * FIFO counting semaphore with a runtime-adjustable limit.
 *
 * Adjustable because a subscription rate-limit warning should be able to drop
 * concurrency to 1 without restarting the process, and raise it again when the
 * window rolls.
 */

export interface Permit {
  release(): void;
}

interface Waiter {
  readonly resolve: (p: Permit) => void;
  readonly reject: (e: Error) => void;
  timer: NodeJS.Timeout | undefined;
  settled: boolean;
}

export class AcquireTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms waiting for a permit`);
    this.name = "AcquireTimeoutError";
  }
}

export class Semaphore {
  private held = 0;
  private limit: number;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number) {
    if (limit < 1) throw new Error("Semaphore limit must be >= 1");
    this.limit = limit;
  }

  get inUse(): number {
    return this.held;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  get capacity(): number {
    return this.limit;
  }

  /**
   * Lowering the limit never revokes a permit already held — in-flight runs
   * finish, and the reduction takes effect as they drain.
   */
  setLimit(limit: number): void {
    if (limit < 1) throw new Error("Semaphore limit must be >= 1");
    this.limit = limit;
    this.drain();
  }

  async acquire(timeoutMs?: number): Promise<Permit> {
    if (this.held < this.limit) {
      this.held += 1;
      return this.permit();
    }

    return new Promise<Permit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: undefined, settled: false };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new AcquireTimeoutError(timeoutMs));
        }, timeoutMs);
        // Don't hold the process open purely for a queued waiter.
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
    });
  }

  /** Acquire, run, and always release — the form callers should prefer. */
  async run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const permit = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      permit.release();
    }
  }

  private permit(): Permit {
    let released = false;
    return {
      release: () => {
        if (released) return; // double release must not inflate capacity
        released = true;
        this.held -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.held < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.held += 1;
      waiter.resolve(this.permit());
    }
  }
}
