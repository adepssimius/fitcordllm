import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.js";

export type Db = DatabaseSync;

/**
 * `node:sqlite` is synchronous. That is an advantage here — a commit is a
 * straight-line statement rather than an await point where a crash can
 * interleave — but it means no unbounded query may sit on the hot path and the
 * tool-call audit must be batched.
 */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  // With WAL, the worst case is losing the last few hundred ms of tool-call
  // audit on power loss. Recovery already treats a mid-flight turn as lost.
  db.exec("PRAGMA synchronous = NORMAL");

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
  );
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    // Each migration and its bookkeeping row land in one transaction, so a
    // crash mid-migration cannot leave a half-applied schema marked as done.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        m.id,
        m.name,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.id} (${m.name}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * BEGIN IMMEDIATE rather than deferred: there is a single writer, but a
 * deferred transaction that upgrades to a write mid-way can hit SQLITE_BUSY
 * against the WAL checkpointer.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
