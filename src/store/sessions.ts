import type { Db } from "./db.js";
import { transaction } from "./db.js";
import type { NewSession, Session, SessionKind, SessionStatus } from "../session/types.js";

interface SessionRow {
  id: string;
  profile: string;
  kind: string;
  status: string;
  guild_id: string;
  channel_id: string;
  thread_id: string;
  agent_session_id: string | null;
  opened_by: string | null;
  title: string;
  branch: string;
  schedule_id: number | null;
  turn_count: number;
  agent_turn_count: number;
  cost_usd: number;
  created_at: number;
  updated_at: number;
  last_turn_at: number | null;
  closed_at: number | null;
}

function hydrate(r: SessionRow): Session {
  return {
    id: r.id,
    profile: r.profile,
    kind: r.kind as SessionKind,
    status: r.status as SessionStatus,
    guildId: r.guild_id,
    channelId: r.channel_id,
    threadId: r.thread_id,
    agentSessionId: r.agent_session_id,
    openedBy: r.opened_by,
    title: r.title,
    branch: r.branch,
    scheduleId: r.schedule_id,
    turnCount: r.turn_count,
    agentTurnCount: r.agent_turn_count,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastTurnAt: r.last_turn_at,
    closedAt: r.closed_at,
  };
}

export interface SessionDao {
  byThread(threadId: string): Session | undefined;
  byId(id: string): Session | undefined;
  create(row: NewSession, now?: number): Session;
  /**
   * Looks a session up by a message a brief was posted as.
   *
   * Used twice: when a thread appears whose id is one of those messages, and
   * when someone replies to one in the channel.
   */
  byAnchor(messageId: string): Session | undefined;
  addAnchors(sessionId: string, messageIds: readonly string[]): void;
  /**
   * Points the session at the thread that now exists for it, and forgets the
   * other anchors: from here on the thread is the only way in, so a second
   * thread started from a different chunk of the same brief is a new
   * conversation rather than a second door into this one.
   */
  bindThread(sessionId: string, threadId: string, now?: number): void;
  clearAgentSession(id: string, now?: number): void;
  setAgentSession(id: string, agentSessionId: string, now?: number): void;
  /** Most recently active first, within one profile. */
  recent(profile: string, limit: number): readonly Session[];
  /** Boot recovery: sessions left mid-run by a crash. */
  resetRunning(now?: number): number;
  /** Moves every session of one profile to another. Returns how many moved. */
  relabelProfile(from: string, to: string, now?: number): number;
}

export function createSessionDao(db: Db): SessionDao {
  const selByThread = db.prepare("SELECT * FROM sessions WHERE thread_id = ?");
  const selById = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const selByAnchor = db.prepare(
    "SELECT s.* FROM sessions s JOIN anchors a ON a.session_id = s.id WHERE a.message_id = ?",
  );
  const selRecent = db.prepare(
    "SELECT * FROM sessions WHERE profile = ? AND status <> 'closed' ORDER BY COALESCE(last_turn_at, created_at) DESC LIMIT ?",
  );
  const ins = db.prepare(
    `INSERT INTO sessions (id, profile, kind, status, guild_id, channel_id, thread_id, agent_session_id,
       opened_by, title, branch, schedule_id, created_at, updated_at)
     VALUES (?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insAnchor = db.prepare("INSERT OR IGNORE INTO anchors (message_id, session_id) VALUES (?, ?)");
  const delAnchors = db.prepare("DELETE FROM anchors WHERE session_id = ?");
  const updThread = db.prepare("UPDATE sessions SET thread_id = ?, updated_at = ? WHERE id = ?");
  const updAgent = db.prepare("UPDATE sessions SET agent_session_id = ?, updated_at = ? WHERE id = ?");
  const resetRun = db.prepare(
    "UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'running'",
  );
  const relabel = db.prepare("UPDATE sessions SET profile = ?, updated_at = ? WHERE profile = ?");

  return {
    byThread(threadId) {
      const r = selByThread.get(threadId) as unknown as SessionRow | undefined;
      return r ? hydrate(r) : undefined;
    },
    byId(id) {
      const r = selById.get(id) as unknown as SessionRow | undefined;
      return r ? hydrate(r) : undefined;
    },
    create(row, now = Date.now()) {
      ins.run(
        row.id,
        row.profile,
        row.kind,
        row.guildId,
        row.channelId,
        row.threadId,
        row.agentSessionId,
        row.openedBy,
        row.title,
        row.branch,
        row.scheduleId,
        now,
        now,
      );
      return hydrate(selById.get(row.id) as unknown as SessionRow);
    },
    byAnchor(messageId) {
      const r = selByAnchor.get(messageId) as unknown as SessionRow | undefined;
      return r ? hydrate(r) : undefined;
    },
    addAnchors(sessionId, messageIds) {
      if (messageIds.length === 0) return;
      transaction(db, () => {
        for (const id of messageIds) insAnchor.run(id, sessionId);
      });
    },
    bindThread(sessionId, threadId, now = Date.now()) {
      transaction(db, () => {
        updThread.run(threadId, now, sessionId);
        delAnchors.run(sessionId);
      });
    },
    clearAgentSession(id, now = Date.now()) {
      updAgent.run(null, now, id);
    },
    setAgentSession(id, agentSessionId, now = Date.now()) {
      updAgent.run(agentSessionId, now, id);
    },
    recent(profile, limit) {
      return (selRecent.all(profile, limit) as unknown as SessionRow[]).map(hydrate);
    },
    resetRunning(now = Date.now()) {
      return transaction(db, () => Number(resetRun.run(now).changes));
    },
    relabelProfile(from, to, now = Date.now()) {
      return Number(relabel.run(to, now, from).changes);
    },
  };
}
