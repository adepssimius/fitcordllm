import type { CoreConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { Schedule } from "../session/types.js";
import type { Store } from "../store/index.js";
import { nextRun } from "./cron.js";

/**
 * Fires scheduled briefs.
 *
 * In-process on purpose. There is exactly one replica (the volume is
 * ReadWriteOnce), so there is no second scheduler to race, and a CronJob would
 * need its own way to reach Discord and the same volume the bot already holds.
 *
 * The next run time is stored, not recomputed from "now" on each tick. That is
 * what lets a restart tell "06:00 has not come yet" from "06:00 passed while I
 * was down" — and decide, in the second case, whether the brief is still
 * worth sending.
 */

export type Plan =
  | { readonly action: "run"; readonly schedule: Schedule; readonly next: number | null }
  | { readonly action: "skip"; readonly schedule: Schedule; readonly next: number | null; readonly lateMs: number };

/** Decides what to do with each due schedule. Pure, so lateness is tested without a clock. */
export function plan(
  due: readonly Schedule[],
  now: number,
  opts: { readonly timeZone: string; readonly maxLateMs: number },
): Plan[] {
  return due.map((schedule) => {
    const next = nextRun(schedule.cron, opts.timeZone, new Date(now))?.getTime() ?? null;
    const lateMs = now - (schedule.nextRunAt ?? now);
    return lateMs > opts.maxLateMs
      ? { action: "skip", schedule, next, lateMs }
      : { action: "run", schedule, next };
  });
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly cfg: CoreConfig,
    private readonly log: Logger,
    private readonly store: Store,
    private readonly run: (schedule: Schedule) => void,
    private readonly sweep: () => Promise<void>,
  ) {}

  start(): void {
    // A schedule saved while the bot's zone was different, or restored from a
    // backup, may have no next run recorded. Give every enabled one a future.
    for (const s of this.store.schedules.list()) {
      if (s.enabled && s.nextRunAt === null) {
        this.store.schedules.advance(s.id, nextRun(s.cron, this.cfg.BOT_TIMEZONE, new Date())?.getTime() ?? null, null);
      }
    }

    this.timer = setInterval(() => this.tick(), this.cfg.SCHEDULE_TICK_MS);
    this.timer.unref?.();

    const sweep = (): void => {
      void this.sweep().catch((e: unknown) => this.log.warn({ err: e }, "workspace cleanup failed"));
    };
    this.sweepTimer = setInterval(sweep, 6 * 3_600_000);
    this.sweepTimer.unref?.();
    sweep();

    this.log.info({ schedules: this.store.schedules.list().length, timeZone: this.cfg.BOT_TIMEZONE }, "scheduler started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  tick(now = Date.now()): void {
    let due: readonly Schedule[];
    try {
      due = this.store.schedules.due(now);
    } catch (e) {
      this.log.error({ err: e }, "could not read due schedules");
      return;
    }

    for (const p of plan(due, now, { timeZone: this.cfg.BOT_TIMEZONE, maxLateMs: this.cfg.SCHEDULE_MAX_LATE_MS })) {
      // Advance BEFORE running: if the process dies mid-brief, the cost is one
      // missed brief, not the same brief again on every restart.
      this.store.schedules.advance(p.schedule.id, p.next, p.action === "run" ? now : null);

      if (p.action === "skip") {
        this.log.warn(
          { schedule: p.schedule.name, lateMinutes: Math.round(p.lateMs / 60_000) },
          "scheduled brief skipped — it came due while the bot was down and is too late to be useful",
        );
        continue;
      }
      this.log.info({ schedule: p.schedule.name }, "scheduled brief due");
      this.run(p.schedule);
    }
  }
}
