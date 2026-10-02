import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { NewSession } from "../session/types.js";
import { openStore, type Store } from "./index.js";

let store: Store;

function newSession(over: Partial<NewSession> = {}) {
  return store.sessions.create({
    id: randomUUID(),
    kind: "chat",
    guildId: "g1",
    channelId: "c1",
    threadId: `t-${randomUUID()}`,
    agentSessionId: randomUUID(),
    openedBy: "u1",
    title: "test",
    branch: "fitcord/test",
    scheduleId: null,
    ...over,
  });
}

beforeEach(() => {
  store = openStore(":memory:");
});

describe("migrations", () => {
  it("apply once", () => {
    const rows = store.raw.prepare("SELECT id, name FROM schema_migrations").all();
    expect(rows).toEqual([
      { id: 1, name: "init" },
      { id: 2, name: "polls" },
    ]);
  });

  it("enforce STRICT typing on the quota ledger", () => {
    const s = newSession();
    expect(() =>
      store.raw.prepare("UPDATE sessions SET agent_turn_count = ? WHERE id = ?").run("lots", s.id),
    ).toThrow();
  });
});

describe("sessions", () => {
  it("are found by thread, with the branch they were given", () => {
    const s = newSession({ threadId: "t1", branch: "fitcord/2026-10-02-long-run-abc123" });
    expect(store.sessions.byThread("t1")).toMatchObject({ id: s.id, branch: "fitcord/2026-10-02-long-run-abc123" });
  });

  it("allow only one session per thread", () => {
    newSession({ threadId: "t1" });
    expect(() => newSession({ threadId: "t1" })).toThrow();
  });

  it("list the most recently active first", () => {
    const old = newSession();
    const fresh = newSession();
    const t = store.turns.begin(
      { sessionId: old.id, trigger: "mention", actorId: null, prompt: "q", resumedFrom: null },
      Date.now() + 1000,
    );
    store.turns.finish(
      t,
      { status: "ok", result: "a", error: null, errorSubtype: null, numTurns: 2, costUsd: 0, deniedToolCount: 0 },
      Date.now() + 2000,
    );
    expect(store.sessions.recent(10).map((s) => s.id)).toEqual([old.id, fresh.id]);
  });

  it("return running sessions to idle on recovery", () => {
    const s = newSession();
    store.turns.begin({ sessionId: s.id, trigger: "mention", actorId: null, prompt: "q", resumedFrom: null });
    expect(store.sessions.byId(s.id)?.status).toBe("running");
    expect(store.sessions.resetRunning()).toBe(1);
    expect(store.sessions.byId(s.id)?.status).toBe("idle");
  });
});

describe("continuing a brief", () => {
  /** A brief posted as three messages; the session is keyed on the first. */
  function brief() {
    const s = newSession({ kind: "brief", threadId: "m1", scheduleId: 7 });
    store.sessions.addAnchors(s.id, ["m1", "m2", "m3"]);
    return s;
  }

  it("resolves from any message the brief was posted as", () => {
    const s = brief();
    expect(store.sessions.byAnchor("m1")?.id).toBe(s.id);
    expect(store.sessions.byAnchor("m3")?.id).toBe(s.id);
    expect(store.sessions.byAnchor("m9")).toBeUndefined();
  });

  it("is already filed under the thread id when the thread starts from its first message", () => {
    // Discord gives a thread the id of the message it was started from.
    const s = brief();
    expect(store.sessions.byThread("m1")?.id).toBe(s.id);
  });

  it("moves to the thread when it is started from a later chunk", () => {
    const s = brief();
    store.sessions.bindThread(s.id, "m3");
    expect(store.sessions.byThread("m3")?.id).toBe(s.id);
    expect(store.sessions.byThread("m1")).toBeUndefined();
  });

  it("has one thread: once bound, the other chunks no longer lead to it", () => {
    const s = brief();
    store.sessions.bindThread(s.id, "m3");
    expect(store.sessions.byAnchor("m2")).toBeUndefined();
  });
});

describe("schedules", () => {
  const row = {
    name: "morning-brief",
    cron: "0 6 * * *",
    prompt: "Run the daily brief.",
    channelId: null,
    enabled: true,
    createdBy: "u1",
    nextRunAt: 1_000,
  };

  it("replace by name rather than piling up", () => {
    store.schedules.upsert(row);
    store.schedules.upsert({ ...row, cron: "30 5 * * *" });
    expect(store.schedules.list().map((s) => s.cron)).toEqual(["30 5 * * *"]);
  });

  it("are due at or after their next run, and only while enabled", () => {
    store.schedules.upsert(row);
    store.schedules.upsert({ ...row, name: "paused", enabled: false });
    expect(store.schedules.due(999)).toEqual([]);
    expect(store.schedules.due(1_000).map((s) => s.name)).toEqual(["morning-brief"]);
  });

  it("stop being due once advanced", () => {
    const s = store.schedules.upsert(row);
    store.schedules.advance(s.id, 90_000, 1_500);
    expect(store.schedules.due(2_000)).toEqual([]);
    expect(store.schedules.byName("morning-brief")).toMatchObject({ nextRunAt: 90_000, lastRunAt: 1_500 });
  });

  it("keep the last run time when a late run is skipped", () => {
    const s = store.schedules.upsert(row);
    store.schedules.advance(s.id, 90_000, 1_500);
    store.schedules.advance(s.id, 180_000, null);
    expect(store.schedules.byName("morning-brief")?.lastRunAt).toBe(1_500);
  });

  it("leave past briefs in place when deleted", () => {
    const s = store.schedules.upsert(row);
    const session = newSession({ kind: "brief", scheduleId: s.id });
    expect(store.schedules.delete("morning-brief")).toBe(true);
    expect(store.sessions.byId(session.id)).toBeDefined();
    expect(store.schedules.delete("morning-brief")).toBe(false);
  });
});

describe("polls", () => {
  function post(sessionId: string, over: { messageId?: string; multi?: boolean } = {}) {
    store.polls.create({
      messageId: over.messageId ?? "poll-1",
      sessionId,
      channelId: "t1",
      key: "rpe",
      question: "How hard was that?",
      options: ["1 — nothing", "2", "3"],
      multi: over.multi ?? false,
    });
  }

  it("are found by the message a vote names", () => {
    const s = newSession();
    post(s.id);
    expect(store.polls.byMessage("poll-1")).toMatchObject({
      sessionId: s.id,
      key: "rpe",
      options: ["1 — nothing", "2", "3"],
      multi: false,
      answeredAt: null,
      answer: null,
    });
    expect(store.polls.byMessage("someone-elses-poll")).toBeUndefined();
  });

  it("take an answer exactly once, so a vote cannot start two turns", () => {
    post(newSession().id);
    expect(store.polls.answer("poll-1", ["2"])).toBe(true);
    expect(store.polls.answer("poll-1", ["3"])).toBe(false);
    expect(store.polls.byMessage("poll-1")?.answer).toEqual(["2"]);
  });

  it("keep every choice of a multi-select answer", () => {
    post(newSession().id, { multi: true });
    store.polls.answer("poll-1", ["2", "3"]);
    expect(store.polls.byMessage("poll-1")).toMatchObject({ multi: true, answer: ["2", "3"] });
  });

  it("report no answer for a poll nobody tapped", () => {
    post(newSession().id);
    expect(store.polls.byMessage("poll-1")?.answeredAt).toBeNull();
  });
});
