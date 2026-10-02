import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoteCollector } from "./votes.js";

type Settled = { messageId: string; userId: string; answerIds: number[] };

let settled: Settled[];
let votes: VoteCollector;

beforeEach(() => {
  vi.useFakeTimers();
  settled = [];
  votes = new VoteCollector({ settleMs: 4_000, multiSettleMs: 15_000, onSettled: (v) => settled.push(v) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a single-choice poll", () => {
  it("reports the tap once it has stood for the settle time", () => {
    votes.add("p1", "u1", 6, false);
    vi.advanceTimersByTime(3_999);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(settled).toEqual([{ messageId: "p1", userId: "u1", answerIds: [6] }]);
  });

  it("takes the corrected answer when a mis-tap is fixed in time", () => {
    // RPE 5 tapped by mistake, then 6. Discord sends an add and a remove, in
    // no guaranteed order.
    votes.add("p1", "u1", 5, false);
    vi.advanceTimersByTime(2_000);
    votes.add("p1", "u1", 6, false);
    votes.remove("p1", "u1", 5, false);
    vi.advanceTimersByTime(4_000);
    expect(settled).toEqual([{ messageId: "p1", userId: "u1", answerIds: [6] }]);
  });

  it("gives the same answer when the remove arrives before the add", () => {
    votes.add("p1", "u1", 5, false);
    votes.remove("p1", "u1", 5, false);
    votes.add("p1", "u1", 6, false);
    vi.advanceTimersByTime(4_000);
    expect(settled.map((s) => s.answerIds)).toEqual([[6]]);
  });

  it("reports nothing when the tap is taken back", () => {
    votes.add("p1", "u1", 5, false);
    votes.remove("p1", "u1", 5, false);
    vi.advanceTimersByTime(60_000);
    expect(settled).toEqual([]);
  });

  it("reports once, not once per event", () => {
    votes.add("p1", "u1", 5, false);
    votes.add("p1", "u1", 6, false);
    votes.add("p1", "u1", 7, false);
    vi.advanceTimersByTime(60_000);
    expect(settled).toHaveLength(1);
  });
});

describe("a multi-select poll", () => {
  it("waits for the taps to stop, then reports them all in order", () => {
    // Sore: calves (3), then quads (1), a pause, then hamstrings (2).
    votes.add("p2", "u1", 3, true);
    vi.advanceTimersByTime(5_000);
    votes.add("p2", "u1", 1, true);
    vi.advanceTimersByTime(10_000);
    expect(settled).toEqual([]);
    votes.add("p2", "u1", 2, true);
    vi.advanceTimersByTime(15_000);
    expect(settled).toEqual([{ messageId: "p2", userId: "u1", answerIds: [1, 2, 3] }]);
  });

  it("drops an option that was untapped", () => {
    votes.add("p2", "u1", 1, true);
    votes.add("p2", "u1", 2, true);
    votes.remove("p2", "u1", 1, true);
    vi.advanceTimersByTime(15_000);
    expect(settled.map((s) => s.answerIds)).toEqual([[2]]);
  });
});

describe("separate polls and people", () => {
  it("keeps two polls asked together apart", () => {
    votes.add("rpe", "u1", 6, false);
    votes.add("soreness", "u1", 2, false);
    vi.advanceTimersByTime(4_000);
    expect(settled.map((s) => [s.messageId, s.answerIds])).toEqual([
      ["rpe", [6]],
      ["soreness", [2]],
    ]);
  });

  it("does not let one person's taps reset another's", () => {
    votes.add("p1", "u1", 6, false);
    vi.advanceTimersByTime(3_000);
    votes.add("p1", "u2", 2, false);
    vi.advanceTimersByTime(1_000);
    expect(settled.map((s) => s.userId)).toEqual(["u1"]);
  });

  it("forgets what is pending on shutdown", () => {
    votes.add("p1", "u1", 6, false);
    votes.clear();
    vi.advanceTimersByTime(60_000);
    expect(settled).toEqual([]);
  });
});
