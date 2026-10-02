import type { Db } from "./db.js";
import { transaction } from "./db.js";
import type { FinishTurn, NewToolCall, NewTurn, TurnRow, TurnStatus } from "../session/types.js";

interface RawTurn {
  id: number;
  session_id: string;
  seq: number;
  status: string;
  trigger: string;
  actor_id: string | null;
  prompt: string;
  resumed_from: string | null;
  result: string | null;
  error: string | null;
  error_subtype: string | null;
  num_turns: number;
  cost_usd: number;
  denied_tool_count: number;
  started_at: number;
  ended_at: number | null;
  discord_message_id: string | null;
}

function hydrate(r: RawTurn): TurnRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    status: r.status as TurnRow["status"],
    trigger: r.trigger as TurnRow["trigger"],
    actorId: r.actor_id,
    prompt: r.prompt,
    resumedFrom: r.resumed_from,
    result: r.result,
    error: r.error,
    errorSubtype: r.error_subtype,
    numTurns: r.num_turns,
    costUsd: r.cost_usd,
    deniedToolCount: r.denied_tool_count,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    discordMessageId: r.discord_message_id,
  };
}

export interface TurnDao {
  /** Step 2 of the commit protocol: durable prompt + running session, atomically. */
  begin(t: NewTurn, now?: number): number;
  /** Step 4: terminal turn state and session counters, atomically. */
  finish(id: number, r: FinishTurn, now?: number): void;
  setDiscordMessage(id: number, messageId: string): void;
  byId(id: number): TurnRow | undefined;
  recent(sessionId: string, limit: number): readonly TurnRow[];
  recordToolCalls(batch: readonly NewToolCall[], now?: number): void;
  /** Quota ledger: SDK turns spent since a timestamp. */
  agentTurnsSince(epochMs: number): number;
  runningCount(): number;
  running(): readonly TurnRow[];
  markInterrupted(ids: readonly number[], now?: number): void;
}

export function createTurnDao(db: Db): TurnDao {
  const nextSeq = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM turns WHERE session_id = ?",
  );
  const ins = db.prepare(
    `INSERT INTO turns (session_id, seq, status, trigger, actor_id, prompt, resumed_from, started_at)
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
  );
  const setSessionRunning = db.prepare(
    "UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?",
  );
  const fin = db.prepare(
    `UPDATE turns SET status = ?, result = ?, error = ?, error_subtype = ?,
       num_turns = ?, cost_usd = ?, denied_tool_count = ?, ended_at = ?
     WHERE id = ?`,
  );
  const applyToSession = db.prepare(
    `UPDATE sessions
       SET status = 'idle',
           turn_count = turn_count + 1,
           agent_turn_count = agent_turn_count + ?,
           cost_usd = cost_usd + ?,
           last_turn_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const selById = db.prepare("SELECT * FROM turns WHERE id = ?");
  const selSessionOf = db.prepare("SELECT session_id FROM turns WHERE id = ?");
  const selRecent = db.prepare(
    "SELECT * FROM turns WHERE session_id = ? AND status = 'ok' ORDER BY seq DESC LIMIT ?",
  );
  const insTool = db.prepare(
    `INSERT INTO tool_calls (turn_id, session_id, tool_name, input_json, allowed, deny_reason, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const sumTurns = db.prepare(
    "SELECT COALESCE(SUM(num_turns), 0) AS n FROM turns WHERE started_at >= ?",
  );
  const cntRunning = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'running'");
  const selRunning = db.prepare("SELECT * FROM turns WHERE status = 'running'");
  const updMsg = db.prepare("UPDATE turns SET discord_message_id = ? WHERE id = ?");
  const updInterrupted = db.prepare(
    "UPDATE turns SET status = 'interrupted', ended_at = ? WHERE id = ? AND status = 'running'",
  );

  return {
    begin(t, now = Date.now()) {
      return transaction(db, () => {
        const seq = (nextSeq.get(t.sessionId) as { n: number }).n;
        const info = ins.run(
          t.sessionId,
          seq,
          t.trigger,
          t.actorId,
          t.prompt,
          t.resumedFrom,
          now,
        );
        setSessionRunning.run(now, t.sessionId);
        return Number(info.lastInsertRowid);
      });
    },

    finish(id, r, now = Date.now()) {
      // Turn state and session counters must move together, or the quota ledger
      // drifts from the audit log.
      transaction(db, () => {
        const row = selSessionOf.get(id) as { session_id: string } | undefined;
        if (!row) throw new Error(`finish: turn ${id} does not exist`);
        fin.run(
          r.status,
          r.result,
          r.error,
          r.errorSubtype,
          r.numTurns,
          r.costUsd,
          r.deniedToolCount,
          now,
          id,
        );
        applyToSession.run(r.numTurns, r.costUsd, now, now, row.session_id);
      });
    },

    setDiscordMessage(id, messageId) {
      updMsg.run(messageId, id);
    },

    byId(id) {
      const r = selById.get(id) as RawTurn | undefined;
      return r ? hydrate(r) : undefined;
    },

    recent(sessionId, limit) {
      return (selRecent.all(sessionId, limit) as unknown as RawTurn[]).map(hydrate).reverse();
    },

    recordToolCalls(batch, now = Date.now()) {
      if (batch.length === 0) return;
      transaction(db, () => {
        for (const c of batch) {
          insTool.run(
            c.turnId,
            c.sessionId,
            c.toolName,
            c.inputJson,
            c.allowed ? 1 : 0,
            c.denyReason,
            now,
          );
        }
      });
    },

    agentTurnsSince(epochMs) {
      return (sumTurns.get(epochMs) as { n: number }).n;
    },

    runningCount() {
      return (cntRunning.get() as { n: number }).n;
    },

    running() {
      return (selRunning.all() as unknown as RawTurn[]).map(hydrate);
    },

    markInterrupted(ids, now = Date.now()) {
      if (ids.length === 0) return;
      transaction(db, () => {
        for (const id of ids) updInterrupted.run(now, id);
      });
    },
  };
}

export type { TurnStatus };
