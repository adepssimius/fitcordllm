import { describe, expect, it } from "vitest";
import type { Schedule } from "../session/types.js";
import { plan } from "./scheduler.js";

const sixAm = new Date("2026-10-02T10:00:00Z").getTime(); // 06:00 New York
const opts = { timeZone: "America/New_York", maxLateMs: 3 * 3_600_000 };

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 1,
    name: "morning-brief",
    cron: "0 6 * * *",
    prompt: "Run the daily brief.",
    channelId: null,
    enabled: true,
    createdBy: null,
    createdAt: 0,
    lastRunAt: null,
    nextRunAt: sixAm,
    ...over,
  };
}

describe("plan", () => {
  it("runs a brief that is due now and moves it to tomorrow", () => {
    const [p] = plan([schedule()], sixAm + 20_000, opts);
    expect(p?.action).toBe("run");
    expect(new Date(p!.next!).toISOString()).toBe("2026-10-03T10:00:00.000Z");
  });

  it("still runs a brief the bot was briefly down for", () => {
    // A 40-minute outage over 06:00: the morning brief is late, not pointless.
    const [p] = plan([schedule()], sixAm + 40 * 60_000, opts);
    expect(p?.action).toBe("run");
  });

  it("skips a brief that came due long ago, but still moves it on", () => {
    // Down from before 06:00 until 14:00: do not deliver breakfast at lunch,
    // and do not leave it due so that it fires on the next tick either.
    const now = sixAm + 8 * 3_600_000;
    const [p] = plan([schedule()], now, opts);
    expect(p?.action).toBe("skip");
    expect(new Date(p!.next!).toISOString()).toBe("2026-10-03T10:00:00.000Z");
  });

  it("gives a schedule with a broken expression no next run instead of throwing", () => {
    const [p] = plan([schedule({ cron: "not a cron" })], sixAm, opts);
    expect(p?.next).toBeNull();
  });
});
