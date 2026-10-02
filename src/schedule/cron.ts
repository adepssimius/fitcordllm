import { Cron } from "croner";

/**
 * Cron handling, kept pure so the rules are tested without a clock.
 *
 * Five fields only. croner also accepts a leading seconds field, and a model
 * asked for "every morning" that emits six fields has scheduled something
 * that fires sixty times in the minute it matches.
 */

export type CronCheck =
  | { readonly ok: true; readonly next: Date }
  | { readonly ok: false; readonly reason: string };

export function nextRun(expr: string, timeZone: string, from: Date): Date | null {
  try {
    return new Cron(expr, { timezone: timeZone, paused: true }).nextRun(from);
  } catch {
    return null;
  }
}

export function checkCron(
  expr: string,
  timeZone: string,
  minIntervalMin: number,
  from: Date = new Date(),
): CronCheck {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      reason: `expected five cron fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    };
  }

  let job: Cron;
  try {
    job = new Cron(expr.trim(), { timezone: timeZone, paused: true });
  } catch (e) {
    return { ok: false, reason: `not a valid cron expression: ${e instanceof Error ? e.message : String(e)}` };
  }

  const runs = job.nextRuns(6, from);
  const first = runs[0];
  if (!first) return { ok: false, reason: "this expression never fires" };

  // Every run spends subscription quota, so a schedule that fires every few
  // minutes is almost certainly a mistake rather than a wish.
  for (let i = 1; i < runs.length; i++) {
    const gapMin = (runs[i]!.getTime() - runs[i - 1]!.getTime()) / 60_000;
    if (gapMin < minIntervalMin) {
      return {
        ok: false,
        reason: `this would fire every ${Math.round(gapMin)} minute(s); the minimum gap is ${minIntervalMin} minutes`,
      };
    }
  }
  return { ok: true, next: first };
}
