import type { Db } from "./db.js";
import type { PollRow } from "../session/types.js";

interface RawPoll {
  message_id: string;
  session_id: string;
  channel_id: string;
  key: string;
  question: string;
  options: string;
  multi: number;
  created_at: number;
  answered_at: number | null;
  answer: string | null;
}

function hydrate(r: RawPoll): PollRow {
  return {
    messageId: r.message_id,
    sessionId: r.session_id,
    channelId: r.channel_id,
    key: r.key,
    question: r.question,
    options: JSON.parse(r.options) as string[],
    multi: r.multi === 1,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    answer: r.answer === null ? null : (JSON.parse(r.answer) as string[]),
  };
}

export interface PollDao {
  create(
    row: Pick<PollRow, "messageId" | "sessionId" | "channelId" | "key" | "question" | "options" | "multi">,
    now?: number,
  ): void;
  byMessage(messageId: string): PollRow | undefined;
  /**
   * Records the answer. Returns false if the poll already had one.
   *
   * The conditional UPDATE is the concurrency control: a vote that settles
   * twice, or arrives again after a restart, changes no rows and so starts no
   * second turn.
   */
  answer(messageId: string, chosen: readonly string[], now?: number): boolean;
}

export function createPollDao(db: Db): PollDao {
  const ins = db.prepare(
    `INSERT INTO polls (message_id, session_id, channel_id, key, question, options, multi, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sel = db.prepare("SELECT * FROM polls WHERE message_id = ?");
  const upd = db.prepare(
    "UPDATE polls SET answered_at = ?, answer = ? WHERE message_id = ? AND answered_at IS NULL",
  );

  return {
    create(row, now = Date.now()) {
      ins.run(
        row.messageId,
        row.sessionId,
        row.channelId,
        row.key,
        row.question,
        JSON.stringify(row.options),
        row.multi ? 1 : 0,
        now,
      );
    },
    byMessage(messageId) {
      const r = sel.get(messageId) as unknown as RawPoll | undefined;
      return r ? hydrate(r) : undefined;
    },
    answer(messageId, chosen, now = Date.now()) {
      return Number(upd.run(now, JSON.stringify(chosen), messageId).changes) > 0;
    },
  };
}
