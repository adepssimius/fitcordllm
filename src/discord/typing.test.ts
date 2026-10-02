import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTyping, type Typeable } from "./typing.js";

const channel = (impl?: () => Promise<unknown>): Typeable & { calls: number } => {
  const c = {
    calls: 0,
    sendTyping: async () => {
      c.calls += 1;
      return impl ? impl() : undefined;
    },
  };
  return c;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startTyping", () => {
  it("types immediately, so the acknowledgement is not itself delayed", () => {
    // The whole point: the operator learns their message landed now, not after
    // the first refresh tick.
    const c = channel();
    startTyping(c);
    expect(c.calls).toBe(1);
  });

  it("refreshes before Discord's ~10s expiry", () => {
    // A gap between expiry and refresh makes the indicator flicker, which reads
    // worse than no indicator at all.
    const c = channel();
    startTyping(c, { intervalMs: 8000 });
    vi.advanceTimersByTime(8000);
    expect(c.calls).toBe(2);
    vi.advanceTimersByTime(16_000);
    expect(c.calls).toBe(4);
  });

  it("stops when told to", () => {
    const c = channel();
    const stop = startTyping(c, { intervalMs: 1000 });
    vi.advanceTimersByTime(2500);
    const atStop = c.calls;
    stop();
    vi.advanceTimersByTime(60_000);
    expect(c.calls).toBe(atStop);
  });

  it("is safe to stop twice", () => {
    // Callers stop from a `finally`, and some paths reach it more than once. A
    // second call must not clear a timer belonging to a later turn.
    const c = channel();
    const stop = startTyping(c);
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });

  it("gives up after the hard deadline", () => {
    // A safety net: reaching this means something failed to call stop(), and
    // typing forever would report a dead turn as an active one.
    const c = channel();
    startTyping(c, { intervalMs: 1000, maxMs: 5000 });
    vi.advanceTimersByTime(5000);
    const atDeadline = c.calls;
    vi.advanceTimersByTime(60_000);
    expect(c.calls).toBe(atDeadline);
  });

  it("survives a failing sendTyping", async () => {
    // A missing typing indicator is cosmetic. Letting it reject would take
    // down a turn that was going to succeed.
    const errors: unknown[] = [];
    const c = channel(() => Promise.reject(new Error("429 rate limited")));
    const stop = startTyping(c, { intervalMs: 1000, onError: (e) => errors.push(e) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.calls).toBeGreaterThan(1);
    expect(errors.length).toBeGreaterThan(0);
    stop();
  });

  it("does not send again after stop even if a send was in flight", async () => {
    const c = channel();
    const stop = startTyping(c, { intervalMs: 1000 });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.calls).toBe(1);
  });
});
