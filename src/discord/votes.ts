/**
 * Decides when a vote on a poll is finished.
 *
 * Discord reports taps, not answers. Changing a single choice arrives as a
 * remove followed by an add; picking three options on a multi-select poll is
 * three separate adds with no "done" after them. Acting on the first event
 * would log a mis-tap, or the first of three sore muscles.
 *
 * So each change restarts a short timer, and the selection as it stands when
 * the timer runs out is the answer. An empty selection — they tapped and then
 * untapped — is no answer, and nothing is reported.
 *
 * No Discord types here, so the timing is tested with a fake clock.
 */

export interface VoteCollectorOptions {
  readonly settleMs: number;
  readonly multiSettleMs: number;
  /** Called once per settled vote, with the chosen answer ids in ascending order. */
  readonly onSettled: (vote: { messageId: string; userId: string; answerIds: number[] }) => void;
}

interface Pending {
  readonly ids: Set<number>;
  timer: NodeJS.Timeout | undefined;
}

export class VoteCollector {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: VoteCollectorOptions) {}

  add(messageId: string, userId: string, answerId: number, multi: boolean): void {
    const p = this.entry(messageId, userId);
    // A single-choice poll holds one answer. Discord sends the remove for the
    // old choice too, but not in a guaranteed order, so do not depend on it.
    if (!multi) p.ids.clear();
    p.ids.add(answerId);
    this.arm(messageId, userId, p, multi);
  }

  remove(messageId: string, userId: string, answerId: number, multi: boolean): void {
    const p = this.entry(messageId, userId);
    p.ids.delete(answerId);
    this.arm(messageId, userId, p, multi);
  }

  /** Drops everything pending, for shutdown. */
  clear(): void {
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
  }

  private entry(messageId: string, userId: string): Pending {
    const key = `${messageId}:${userId}`;
    let p = this.pending.get(key);
    if (!p) {
      p = { ids: new Set(), timer: undefined };
      this.pending.set(key, p);
    }
    return p;
  }

  private arm(messageId: string, userId: string, p: Pending, multi: boolean): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(
      () => {
        this.pending.delete(`${messageId}:${userId}`);
        if (p.ids.size === 0) return;
        this.opts.onSettled({ messageId, userId, answerIds: [...p.ids].sort((a, b) => a - b) });
      },
      multi ? this.opts.multiSettleMs : this.opts.settleMs,
    );
    p.timer.unref?.();
  }
}
