import type { Db } from "./db.js";

/**
 * Small key/value scratchpad for things that must survive a restart but do not
 * deserve a table — chiefly the quota cooldown, so a restart does not
 * immediately re-probe an exhausted subscription limit.
 */
export interface StateDao {
  get(key: string): string | undefined;
  set(key: string, value: string, now?: number): void;
  delete(key: string): void;
  getJson<T>(key: string): T | undefined;
  setJson(key: string, value: unknown, now?: number): void;
}

export function createStateDao(db: Db): StateDao {
  const sel = db.prepare("SELECT value FROM runtime_state WHERE key = ?");
  const up = db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const del = db.prepare("DELETE FROM runtime_state WHERE key = ?");

  const dao: StateDao = {
    get(key) {
      return (sel.get(key) as { value: string } | undefined)?.value;
    },
    set(key, value, now = Date.now()) {
      up.run(key, value, now);
    },
    delete(key) {
      del.run(key);
    },
    getJson<T>(key: string): T | undefined {
      const raw = dao.get(key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    setJson(key, value, now = Date.now()) {
      dao.set(key, JSON.stringify(value), now);
    },
  };

  return dao;
}
