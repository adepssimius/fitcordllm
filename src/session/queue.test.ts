import { describe, expect, it, vi } from "vitest";
import { ThreadQueue } from "./queue.js";

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("ThreadQueue", () => {
  it("runs a single message immediately", async () => {
    const seen: string[] = [];
    const q = new ThreadQueue<string>(async (head) => {
      seen.push(head);
    }, { maxPending: 5 });

    const r = q.enqueue("t1", "hello");
    expect(r.accepted).toBe(true);
    expect(r.queued).toBe(false);
    await vi.waitFor(() => expect(seen).toEqual(["hello"]));
  });

  it("coalesces messages that arrive mid-run into one turn", async () => {
    const gate = defer();
    const calls: { head: string; rest: readonly string[] }[] = [];
    const q = new ThreadQueue<string>(async (head, rest) => {
      calls.push({ head, rest });
      if (calls.length === 1) await gate.promise;
    }, { maxPending: 5 });

    q.enqueue("t1", "first");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // Three follow-ups while the first run is in flight.
    expect(q.enqueue("t1", "second").queued).toBe(true);
    expect(q.enqueue("t1", "third").queued).toBe(true);
    expect(q.enqueue("t1", "fourth").queued).toBe(true);

    gate.resolve();

    // They drain as a SINGLE additional turn, not three.
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ head: "second", rest: ["third", "fourth"] });
  });

  it("refuses once the pending buffer is full", async () => {
    const gate = defer();
    const q = new ThreadQueue<string>(async () => {
      await gate.promise;
    }, { maxPending: 2 });

    q.enqueue("t1", "running");
    await vi.waitFor(() => expect(q.isRunning("t1")).toBe(true));

    expect(q.enqueue("t1", "a").accepted).toBe(true);
    expect(q.enqueue("t1", "b").accepted).toBe(true);
    const overflow = q.enqueue("t1", "c");
    expect(overflow.accepted).toBe(false);

    gate.resolve();
    await vi.waitFor(() => expect(q.isRunning("t1")).toBe(false));
  });

  it("keeps separate threads independent", async () => {
    const gate = defer();
    const seen: string[] = [];
    const q = new ThreadQueue<string>(async (head) => {
      seen.push(head);
      if (head === "slow") await gate.promise;
    }, { maxPending: 5 });

    q.enqueue("slow-thread", "slow");
    await vi.waitFor(() => expect(seen).toContain("slow"));

    // A different thread must not be blocked behind it.
    q.enqueue("fast-thread", "fast");
    await vi.waitFor(() => expect(seen).toContain("fast"));

    gate.resolve();
  });

  it("keeps draining after a handler throws", async () => {
    const seen: string[] = [];
    const onError = vi.fn();
    const q = new ThreadQueue<string>(async (head) => {
      seen.push(head);
      if (head === "boom") throw new Error("handler failed");
    }, { maxPending: 5, onError });

    q.enqueue("t1", "boom");
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());

    q.enqueue("t1", "after");
    await vi.waitFor(() => expect(seen).toEqual(["boom", "after"]));
  });

  it("releases the lane once idle", async () => {
    const q = new ThreadQueue<string>(async () => {}, { maxPending: 5 });
    q.enqueue("t1", "x");
    await vi.waitFor(() => expect(q.activeLanes).toBe(0));
    expect(q.depth("t1")).toBe(0);
  });
});
