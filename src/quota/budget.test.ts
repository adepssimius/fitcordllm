import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { loadCore, resetConfigCache, type CoreConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { openStore, type Store } from "../store/index.js";
import { QuotaGuard, explainVerdict } from "./budget.js";
import { Semaphore, AcquireTimeoutError } from "../util/semaphore.js";

function cfgWith(over: Record<string, string> = {}): CoreConfig {
  resetConfigCache();
  const c = loadCore({ DATA_DIR: "/tmp/fitcord-test", ...over } as NodeJS.ProcessEnv);
  resetConfigCache();
  return c;
}

const silentLog = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as Logger;

let store: Store;

function seedTurns(sessionId: string, numTurns: number, startedAt: number): void {
  const id = store.turns.begin(
    { sessionId, trigger: "mention", actorId: null, prompt: "q", resumedFrom: null },
    startedAt,
  );
  store.turns.finish(id, {
    status: "ok", result: "a", error: null, errorSubtype: null,
    numTurns, costUsd: 0, deniedToolCount: 0,
  });
}

function newSession(): string {
  const s = store.sessions.create({
    id: randomUUID(), kind: "chat", guildId: "g", channelId: "c", threadId: `t-${randomUUID()}`,
    agentSessionId: randomUUID(), openedBy: null, title: "t", branch: "fitcord/t", scheduleId: null,
  });
  return s.id;
}

beforeEach(() => {
  store = openStore(":memory:");
});

describe("hourly turn budget", () => {
  it("allows a run while under the limit", () => {
    const cfg = cfgWith({ AGENT_TURNS_PER_HOUR: "60" });
    const g = new QuotaGuard(cfg, silentLog, store);
    seedTurns(newSession(), 10, Date.now() - 60_000);
    expect(g.check().allowed).toBe(true);
  });

  it("refuses once the window's spend reaches the limit", () => {
    const cfg = cfgWith({ AGENT_TURNS_PER_HOUR: "10" });
    const g = new QuotaGuard(cfg, silentLog, store);
    const sid = newSession();
    seedTurns(sid, 10, Date.now() - 60_000);

    const v = g.check();
    expect(v.allowed).toBe(false);
    if (!v.allowed && v.reason === "hourly-budget") {
      expect(v.spent).toBe(10);
      expect(v.limit).toBe(10);
    } else {
      throw new Error("expected an hourly-budget refusal");
    }
  });

  it("ignores spend that has aged out of the window", () => {
    const cfg = cfgWith({ AGENT_TURNS_PER_HOUR: "10" });
    const g = new QuotaGuard(cfg, silentLog, store);
    seedTurns(newSession(), 50, Date.now() - 7_200_000); // two hours ago
    expect(g.check().allowed).toBe(true);
  });

  it("reserves for in-flight runs so simultaneous starts cannot all see zero spend", () => {
    const cfg = cfgWith({ AGENT_TURNS_PER_HOUR: "10", AGENT_INFLIGHT_TURN_ESTIMATE: "5" });
    const g = new QuotaGuard(cfg, silentLog, store);
    const sid = newSession();

    // Two runs in flight, nothing recorded yet: 0 spent + 2*5 reserved >= 10.
    store.turns.begin({ sessionId: sid, trigger: "mention", actorId: null, prompt: "a", resumedFrom: null });
    store.turns.begin({ sessionId: sid, trigger: "mention", actorId: null, prompt: "b", resumedFrom: null });

    expect(store.turns.agentTurnsSince(0)).toBe(0);
    expect(g.check().allowed).toBe(false);
  });
});

describe("reactive cooldown", () => {
  const rejected = (over: Partial<SDKRateLimitInfo> = {}): SDKRateLimitInfo => ({
    status: "rejected",
    rateLimitType: "seven_day_opus",
    resetsAt: Math.floor((Date.now() + 3_600_000) / 1000),
    ...over,
  });

  it("refuses subsequent runs after a rejection, regardless of the hourly counter", () => {
    const cfg = cfgWith({ AGENT_TURNS_PER_HOUR: "1000" });
    const g = new QuotaGuard(cfg, silentLog, store);
    expect(g.check().allowed).toBe(true);

    g.onRateLimit(rejected());

    const v = g.check();
    expect(v.allowed).toBe(false);
    if (!v.allowed && v.reason === "cooldown") {
      expect(v.rateLimitType).toBe("seven_day_opus");
    } else {
      throw new Error("expected a cooldown refusal");
    }
  });

  it("survives a restart, so a fresh process does not immediately re-probe", () => {
    const cfg = cfgWith();
    new QuotaGuard(cfg, silentLog, store).onRateLimit(rejected());

    // Same database, brand-new guard — simulating a pod restart.
    const afterRestart = new QuotaGuard(cfg, silentLog, store);
    expect(afterRestart.check().allowed).toBe(false);
  });

  it("clears itself once the reset time passes", () => {
    const cfg = cfgWith();
    const g = new QuotaGuard(cfg, silentLog, store);
    g.onRateLimit(rejected({ resetsAt: Math.floor((Date.now() - 1000) / 1000) }));
    expect(g.check().allowed).toBe(true);
    expect(g.cooldown()).toBeNull();
  });

  it("falls back to a bounded cooldown when the server sends no reset time", () => {
    const cfg = cfgWith();
    const g = new QuotaGuard(cfg, silentLog, store);
    const info = { status: "rejected", rateLimitType: "five_hour" } as SDKRateLimitInfo;
    g.onRateLimit(info);
    const cd = g.cooldown();
    expect(cd).not.toBeNull();
    expect(cd!.until).toBeGreaterThan(Date.now());
  });

  it("notifies once with a message that names the reset time", () => {
    const onCooldown = vi.fn();
    const g = new QuotaGuard(cfgWith(), silentLog, store, { onCooldown });
    g.onRateLimit(rejected());
    expect(onCooldown).toHaveBeenCalledTimes(1);
    expect(String(onCooldown.mock.calls[0]?.[1])).toContain("seven_day_opus");
  });
});

describe("utilization pressure", () => {
  it("drops concurrency to 1 and warns once per window", () => {
    const onWarning = vi.fn();
    const cfg = cfgWith({ AGENT_MAX_CONCURRENT_RUNS: "3", QUOTA_WARN_UTILIZATION: "0.8" });
    const g = new QuotaGuard(cfg, silentLog, store, { onWarning });

    expect(g.semaphore.capacity).toBe(3);
    g.onRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.85 });
    expect(g.semaphore.capacity).toBe(1);
    expect(onWarning).toHaveBeenCalledTimes(1);

    // Still high — must not spam.
    g.onRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.9 });
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it("restores concurrency when the window rolls", () => {
    const cfg = cfgWith({ AGENT_MAX_CONCURRENT_RUNS: "3" });
    const g = new QuotaGuard(cfg, silentLog, store);
    g.onRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.9 });
    expect(g.semaphore.capacity).toBe(1);

    g.onRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 });
    expect(g.semaphore.capacity).toBe(3);
  });

  it("treats allowed_warning as pressure even with no utilization figure", () => {
    const cfg = cfgWith({ AGENT_MAX_CONCURRENT_RUNS: "2" });
    const g = new QuotaGuard(cfg, silentLog, store);
    g.onRateLimit({ status: "allowed_warning", rateLimitType: "five_hour" });
    expect(g.semaphore.capacity).toBe(1);
  });

  it("leaves concurrency alone on a normal allowed report", () => {
    const cfg = cfgWith({ AGENT_MAX_CONCURRENT_RUNS: "2" });
    const g = new QuotaGuard(cfg, silentLog, store);
    // Shape observed from the live SDK: allowed, no utilization field.
    g.onRateLimit({
      status: "allowed", rateLimitType: "five_hour", resetsAt: 1786300200, isUsingOverage: false,
    });
    expect(g.semaphore.capacity).toBe(2);
  });
});

describe("operator-facing text", () => {
  it("says explicitly that nothing was spent, so the operator does not retry blindly", () => {
    const budget = explainVerdict({
      allowed: false, reason: "hourly-budget", spent: 62, limit: 60, retryAt: Date.now(),
    });
    expect(budget).toContain("62/60");
    expect(budget).toContain("Nothing was sent to the model");

    const cd = explainVerdict({
      allowed: false, reason: "cooldown", until: Date.now(), rateLimitType: "seven_day_opus",
    });
    expect(cd).toContain("Nothing was sent to the model");
    // Discord relative timestamps stay correct as the message ages.
    expect(cd).toMatch(/<t:\d+:R>/);
  });
});

describe("semaphore", () => {
  it("serialises beyond its limit and releases in FIFO order", async () => {
    const s = new Semaphore(1);
    const order: number[] = [];
    const a = await s.acquire();
    const second = s.acquire().then((p) => { order.push(2); p.release(); });
    const third = s.acquire().then((p) => { order.push(3); p.release(); });
    expect(s.waiting).toBe(2);
    a.release();
    await Promise.all([second, third]);
    expect(order).toEqual([2, 3]);
  });

  it("times out a waiter without leaking capacity", async () => {
    const s = new Semaphore(1);
    const held = await s.acquire();
    await expect(s.acquire(20)).rejects.toBeInstanceOf(AcquireTimeoutError);
    expect(s.waiting).toBe(0);
    held.release();
    expect(s.inUse).toBe(0);
  });

  it("ignores a double release rather than inflating capacity", async () => {
    const s = new Semaphore(1);
    const p = await s.acquire();
    p.release();
    p.release();
    expect(s.inUse).toBe(0);
    await s.acquire();
    expect(s.inUse).toBe(1);
  });

  it("lowering the limit does not revoke a held permit", async () => {
    const s = new Semaphore(2);
    const a = await s.acquire();
    const b = await s.acquire();
    s.setLimit(1);
    expect(s.inUse).toBe(2);
    a.release();
    b.release();
    expect(s.inUse).toBe(0);
  });

  it("run() always releases, even when the body throws", async () => {
    const s = new Semaphore(1);
    await expect(s.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(s.inUse).toBe(0);
  });
});
