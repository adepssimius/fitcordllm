/**
 * Schema and forward-only migrations.
 *
 * STRICT tables everywhere: SQLite's default type affinity silently accepts a
 * string in an INTEGER column, and this database is the quota ledger.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

// `schema_migrations` is bootstrapped by migrate() in db.ts before any
// migration runs, so it must not be recreated here.
const INIT = `
CREATE TABLE schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  cron        TEXT    NOT NULL,
  prompt      TEXT    NOT NULL,
  channel_id  TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  last_run_at INTEGER,
  next_run_at INTEGER
) STRICT;

CREATE UNIQUE INDEX schedules_name ON schedules(name);
CREATE INDEX schedules_due ON schedules(next_run_at) WHERE enabled = 1;

CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY,
  kind             TEXT    NOT NULL CHECK (kind IN ('chat','brief')),
  status           TEXT    NOT NULL CHECK (status IN ('idle','running','closed')),
  guild_id         TEXT    NOT NULL,
  channel_id       TEXT    NOT NULL,
  thread_id        TEXT    NOT NULL,
  agent_session_id TEXT,
  opened_by        TEXT,
  title            TEXT    NOT NULL DEFAULT '',
  branch           TEXT    NOT NULL,
  -- No foreign key: deleting a schedule must not take its past briefs with it.
  schedule_id      INTEGER,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  agent_turn_count INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL    NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_turn_at     INTEGER,
  closed_at        INTEGER
) STRICT;

-- One session per Discord thread. This is what makes thread_id a safe lookup key.
CREATE UNIQUE INDEX sessions_thread ON sessions(thread_id);
CREATE INDEX sessions_recent ON sessions(updated_at);

-- Every message a scheduled brief was posted as. A thread started from any of
-- them carries that message's id, and is matched back to the session here.
CREATE TABLE anchors (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX anchors_session ON anchors(session_id);

CREATE TABLE turns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('running','ok','error','interrupted','aborted')),
  trigger            TEXT    NOT NULL CHECK (trigger IN ('mention','thread_message','schedule')),
  actor_id           TEXT,
  prompt             TEXT    NOT NULL,
  resumed_from       TEXT,
  result             TEXT,
  error              TEXT,
  error_subtype      TEXT,
  num_turns          INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0,
  denied_tool_count  INTEGER NOT NULL DEFAULT 0,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  discord_message_id TEXT
) STRICT;

CREATE UNIQUE INDEX turns_session_seq ON turns(session_id, seq);
CREATE INDEX turns_budget    ON turns(started_at);
CREATE INDEX turns_running   ON turns(id) WHERE status = 'running';

CREATE TABLE tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id     INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL,
  tool_name   TEXT    NOT NULL,
  input_json  TEXT    NOT NULL,
  allowed     INTEGER NOT NULL CHECK (allowed IN (0,1)),
  deny_reason TEXT,
  at          INTEGER NOT NULL
) STRICT;

CREATE INDEX tool_calls_turn   ON tool_calls(turn_id);
CREATE INDEX tool_calls_denied ON tool_calls(at) WHERE allowed = 0;

CREATE TABLE runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

/**
 * Polls the bot has posted. Keyed by the Discord message, because that is all a
 * vote event carries: which poll message, which answer, which user.
 */
const POLLS = `
CREATE TABLE polls (
  message_id  TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel_id  TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  question    TEXT    NOT NULL,
  options     TEXT    NOT NULL,
  multi       INTEGER NOT NULL CHECK (multi IN (0,1)),
  created_at  INTEGER NOT NULL,
  answered_at INTEGER,
  answer      TEXT
) STRICT;

CREATE INDEX polls_session ON polls(session_id);
`;

/**
 * Profiles: one bot serving several people. Rows that predate this belong to
 * the profile called `default`, which is also what a deployment with no
 * FITCORD_PROFILES is called — so an existing single-person installation keeps
 * every thread. Schedule names become unique per profile instead of globally.
 */
const PROFILES = `
ALTER TABLE sessions  ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
ALTER TABLE schedules ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
DROP INDEX schedules_name;
CREATE UNIQUE INDEX schedules_profile_name ON schedules(profile, name);
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: "init", sql: INIT },
  { id: 2, name: "polls", sql: POLLS },
  { id: 3, name: "profiles", sql: PROFILES },
];
