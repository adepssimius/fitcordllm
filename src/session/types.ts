/**
 * A session is one conversation: one resumable SDK transcript and one clone of
 * the repository on its own branch.
 *
 * It usually maps to a Discord thread. A scheduled brief is the exception for
 * a while: it is posted to the channel as an ordinary message, and only
 * becomes a thread if someone continues it. Until then `threadId` holds the id
 * of that message — which is also the id Discord gives a thread started from
 * it, so nothing has to change when the thread appears.
 *
 * Nullable rather than optional throughout: `exactOptionalPropertyTypes` is on,
 * and optional properties turn every DAO write into a conditional spread.
 */

export type SessionKind = "chat" | "brief";

export type SessionStatus = "idle" | "running" | "closed";

export type TurnTrigger = "mention" | "thread_message" | "schedule";
export type TurnStatus = "running" | "ok" | "error" | "interrupted" | "aborted";

export interface Session {
  readonly id: string;
  /** Whose setup this conversation belongs to — see ProfileConfig. */
  readonly profile: string;
  readonly kind: SessionKind;
  readonly status: SessionStatus;
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId: string;
  /**
   * The SDK session uuid. Generated before the first run and passed as
   * Options.sessionId, so it is durable before the subprocess exists — a crash
   * between query() starting and the first system/init cannot orphan it.
   */
  readonly agentSessionId: string | null;
  readonly openedBy: string | null;
  readonly title: string;
  /** The branch this session's clone is on. */
  readonly branch: string;
  /** The schedule that produced a brief; null for chat. */
  readonly scheduleId: number | null;
  /** Human messages answered. */
  readonly turnCount: number;
  /** Cumulative SDK turns — the currency the quota budget is denominated in. */
  readonly agentTurnCount: number;
  readonly costUsd: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastTurnAt: number | null;
  readonly closedAt: number | null;
}

export interface NewSession {
  readonly id: string;
  readonly profile: string;
  readonly kind: SessionKind;
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly agentSessionId: string;
  readonly openedBy: string | null;
  readonly title: string;
  readonly branch: string;
  readonly scheduleId: number | null;
}

export interface TurnRow {
  readonly id: number;
  readonly sessionId: string;
  readonly seq: number;
  readonly status: TurnStatus;
  readonly trigger: TurnTrigger;
  readonly actorId: string | null;
  readonly prompt: string;
  /** The agentSessionId passed as `resume`, or null for a fresh session. */
  readonly resumedFrom: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly errorSubtype: string | null;
  readonly numTurns: number;
  readonly costUsd: number;
  readonly deniedToolCount: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly discordMessageId: string | null;
}

export interface NewTurn {
  readonly sessionId: string;
  readonly trigger: TurnTrigger;
  readonly actorId: string | null;
  readonly prompt: string;
  readonly resumedFrom: string | null;
}

export interface FinishTurn {
  readonly status: TurnStatus;
  readonly result: string | null;
  readonly error: string | null;
  readonly errorSubtype: string | null;
  readonly numTurns: number;
  readonly costUsd: number;
  readonly deniedToolCount: number;
}

export interface NewToolCall {
  readonly turnId: number;
  readonly sessionId: string;
  readonly toolName: string;
  readonly inputJson: string;
  readonly allowed: boolean;
  readonly denyReason: string | null;
}

/** A recurring prompt whose answer is posted to a channel. */
export interface Schedule {
  readonly id: number;
  readonly profile: string;
  /** Unique within its profile, and what the operator refers to it by. */
  readonly name: string;
  /** Five-field cron, evaluated in BOT_TIMEZONE. */
  readonly cron: string;
  readonly prompt: string;
  /** Null means the configured brief channel. */
  readonly channelId: string | null;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly lastRunAt: number | null;
  readonly nextRunAt: number | null;
}

export interface NewSchedule {
  readonly profile: string;
  readonly name: string;
  readonly cron: string;
  readonly prompt: string;
  readonly channelId: string | null;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly nextRunAt: number | null;
}

/** A poll the agent asked for during a turn; the bot posts it after the reply. */
export interface PollRequest {
  /** What the answer is, in a word: `rpe`, `soreness`, `ship`. Echoed back with the vote. */
  readonly key: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly multi: boolean;
}

/** A poll that has been posted, and the answer once there is one. */
export interface PollRow extends PollRequest {
  readonly messageId: string;
  readonly sessionId: string;
  /** Where the poll message is: a thread for a conversation, a channel for a brief. */
  readonly channelId: string;
  readonly createdAt: number;
  readonly answeredAt: number | null;
  readonly answer: readonly string[] | null;
}
