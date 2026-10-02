import { describe, expect, it } from "vitest";
import { checkCron, nextRun } from "./cron.js";

const from = new Date("2026-10-02T12:00:00Z"); // 08:00 in New York (EDT)

describe("nextRun", () => {
  it("evaluates the expression in the configured zone", () => {
    // 06:00 New York has passed today, so the next one is tomorrow: 10:00 UTC.
    expect(nextRun("0 6 * * *", "America/New_York", from)?.toISOString()).toBe("2026-10-03T10:00:00.000Z");
    expect(nextRun("0 6 * * *", "UTC", from)?.toISOString()).toBe("2026-10-03T06:00:00.000Z");
  });

  it("follows the zone across the end of daylight saving", () => {
    // After 2026-11-01 New York is UTC-5, so 06:00 local becomes 11:00 UTC.
    const afterChange = new Date("2026-11-02T00:00:00Z");
    expect(nextRun("0 6 * * *", "America/New_York", afterChange)?.toISOString()).toBe("2026-11-02T11:00:00.000Z");
  });

  it("returns null for garbage rather than throwing", () => {
    expect(nextRun("every morning", "UTC", from)).toBeNull();
  });
});

describe("checkCron", () => {
  it("accepts a daily schedule and reports its first run", () => {
    const c = checkCron("0 6 * * *", "America/New_York", 30, from);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.next.toISOString()).toBe("2026-10-03T10:00:00.000Z");
  });

  it("accepts weekly and weekday schedules", () => {
    expect(checkCron("30 19 * * 0", "UTC", 30, from).ok).toBe(true);
    expect(checkCron("0 6 * * 1-5", "UTC", 30, from).ok).toBe(true);
  });

  it("refuses a six-field expression, which would add a seconds column", () => {
    const c = checkCron("0 0 6 * * *", "UTC", 30, from);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain("five");
  });

  it("refuses a schedule that fires more often than the minimum gap", () => {
    const c = checkCron("*/5 * * * *", "UTC", 30, from);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain("minimum gap");
  });

  it("allows exactly the minimum gap", () => {
    expect(checkCron("*/30 * * * *", "UTC", 30, from).ok).toBe(true);
  });

  it("refuses an invalid expression with a reason", () => {
    const c = checkCron("61 6 * * *", "UTC", 30, from);
    expect(c.ok).toBe(false);
  });
});
