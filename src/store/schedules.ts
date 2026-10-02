import type { Db } from "./db.js";
import type { NewSchedule, Schedule } from "../session/types.js";

interface ScheduleRow {
  id: number;
  profile: string;
  name: string;
  cron: string;
  prompt: string;
  channel_id: string | null;
  enabled: number;
  created_by: string | null;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

function hydrate(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    profile: r.profile,
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    channelId: r.channel_id,
    enabled: r.enabled === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
  };
}

export interface ScheduleDao {
  /** One profile's schedules, or every profile's when none is given. */
  list(profile?: string): readonly Schedule[];
  byId(id: number): Schedule | undefined;
  byName(profile: string, name: string): Schedule | undefined;
  /** Creates the schedule, or replaces the one with the same name in the same profile. */
  upsert(row: NewSchedule, now?: number): Schedule;
  delete(profile: string, name: string): boolean;
  /** Enabled schedules of every profile whose next run is at or before `now`. */
  due(now: number): readonly Schedule[];
  /**
   * Moves a schedule on to its next run. Called BEFORE the brief is produced,
   * so a crash mid-run costs one missed brief rather than a brief on every
   * restart.
   */
  advance(id: number, nextRunAt: number | null, ranAt: number | null): void;
  /** Moves every schedule of one profile to another. Returns how many moved. */
  relabelProfile(from: string, to: string): number;
}

export function createScheduleDao(db: Db): ScheduleDao {
  const selAll = db.prepare("SELECT * FROM schedules ORDER BY profile, name");
  const selProfile = db.prepare("SELECT * FROM schedules WHERE profile = ? ORDER BY name");
  const selById = db.prepare("SELECT * FROM schedules WHERE id = ?");
  const selByName = db.prepare("SELECT * FROM schedules WHERE profile = ? AND name = ?");
  const selDue = db.prepare(
    "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
  );
  const up = db.prepare(
    `INSERT INTO schedules (profile, name, cron, prompt, channel_id, enabled, created_by, created_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile, name) DO UPDATE SET
       cron = excluded.cron, prompt = excluded.prompt, channel_id = excluded.channel_id,
       enabled = excluded.enabled, next_run_at = excluded.next_run_at`,
  );
  const del = db.prepare("DELETE FROM schedules WHERE profile = ? AND name = ?");
  const adv = db.prepare(
    "UPDATE schedules SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at) WHERE id = ?",
  );
  const relabel = db.prepare("UPDATE schedules SET profile = ? WHERE profile = ?");

  return {
    list(profile) {
      const rows = profile === undefined ? selAll.all() : selProfile.all(profile);
      return (rows as unknown as ScheduleRow[]).map(hydrate);
    },
    byId(id) {
      const r = selById.get(id) as unknown as ScheduleRow | undefined;
      return r ? hydrate(r) : undefined;
    },
    byName(profile, name) {
      const r = selByName.get(profile, name) as unknown as ScheduleRow | undefined;
      return r ? hydrate(r) : undefined;
    },
    upsert(row, now = Date.now()) {
      up.run(
        row.profile,
        row.name,
        row.cron,
        row.prompt,
        row.channelId,
        row.enabled ? 1 : 0,
        row.createdBy,
        now,
        row.nextRunAt,
      );
      return hydrate(selByName.get(row.profile, row.name) as unknown as ScheduleRow);
    },
    delete(profile, name) {
      return Number(del.run(profile, name).changes) > 0;
    },
    due(now) {
      return (selDue.all(now) as unknown as ScheduleRow[]).map(hydrate);
    },
    advance(id, nextRunAt, ranAt) {
      adv.run(nextRunAt, ranAt, id);
    },
    relabelProfile(from, to) {
      return Number(relabel.run(to, from).changes);
    },
  };
}
