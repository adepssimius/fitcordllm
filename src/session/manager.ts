import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionInfo, renameSession, type SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { CoreConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { buildOptions } from "../agent/options.js";
import {
  briefUserPrompt,
  chatUserPrompt,
  stripTurnHeader,
  systemAppend,
  type ChatMessageContext,
  type TurnContext,
} from "../agent/prompts.js";
import { runQuery, type AgentSink } from "../agent/runner.js";
import { branchName, localDate } from "../git/slug.js";
import type { Workspaces, WorkspaceStatus } from "../git/workspaces.js";
import { explainVerdict, type QuotaGuard } from "../quota/budget.js";
import type { Store } from "../store/index.js";
import type { ExternalTools } from "../suunto/mcp.js";
import { createFitcordServer, fitcordToolNames, POLLS_PER_TURN } from "../tools/fitcord.js";
import type { NewToolCall, PollRequest, Schedule, Session, TurnTrigger } from "./types.js";

/**
 * Owns the commit protocol. Nothing else writes session or turn state.
 *
 * Ordering (each step is what makes the next one recoverable):
 *   1. the Discord message or thread exists, then the session row
 *   2. the session's clone exists
 *   3. turn row + session running, atomically, BEFORE any token is spent
 *   4. tool-call audit streams in, batched
 *   5. terminal turn state + session counters, atomically
 *   6. caller delivers to Discord and records the message id
 *
 * What makes a thread survive a restart is three things on the volume, all
 * keyed by the session id: this row, the clone at `threads/<id>`, and the SDK
 * transcript, which the SDK files under that same directory path. Lose the
 * transcript and the turn still runs, from a short recap; lose the clone and it
 * is recreated from the base branch.
 */

export interface ManagerDeps {
  readonly cfg: CoreConfig;
  readonly log: Logger;
  readonly store: Store;
  readonly workspaces: Workspaces;
  readonly external: ExternalTools;
  /** Omit to run unmetered — dev only. */
  readonly quota?: QuotaGuard;
}

export interface TurnRan {
  readonly blocked: false;
  readonly turnId: number;
  readonly ok: boolean;
  readonly text: string;
  readonly numTurns: number;
  readonly costUsd: number;
  readonly deniedTools: number;
  /** True when the SDK transcript was gone and context was rebuilt from SQLite. */
  readonly contextRebuilt: boolean;
  /** True when this turn had to create the clone — a new thread, or one swept for being idle. */
  readonly workspaceCreated: boolean;
  /** Polls the agent asked for. The caller posts them after delivering the reply. */
  readonly polls: readonly PollRequest[];
  readonly rateLimit?: SDKRateLimitInfo;
}

/** Refused before anything was sent to the model. No turn row, no spend. */
export interface TurnBlocked {
  readonly blocked: true;
  readonly message: string;
}

export type TurnResult = TurnRan | TurnBlocked;

interface ExecuteRequest {
  readonly session: Session;
  readonly trigger: TurnTrigger;
  readonly actorId: string | null;
  readonly buildPrompt: (turn: TurnContext) => string;
  /** False for a scheduled run: no publishing or scheduling tools. */
  readonly interactive: boolean;
}

const TOOL_FLUSH_EVERY = 10;

export class SessionManager {
  private readonly aborted = new Set<string>();
  private runScheduleNow: ((s: Schedule) => void) | undefined;

  constructor(private readonly deps: ManagerDeps) {}

  /** Wired by the bot once it can post to a channel. */
  onRunScheduleNow(fn: (s: Schedule) => void): void {
    this.runScheduleNow = fn;
  }

  /** Step 1 for chat. The caller must have created the Discord thread already. */
  openChat(input: {
    guildId: string;
    channelId: string;
    threadId: string;
    openedBy: string | null;
    title: string;
  }): Session {
    const existing = this.deps.store.sessions.byThread(input.threadId);
    if (existing) return existing;
    return this.create("chat", { ...input, scheduleId: null });
  }

  /**
   * Step 1 for a scheduled brief. `anchorId` is the id of the message already
   * posted to the channel — and the id any thread started from it will have.
   */
  openBrief(input: { guildId: string; channelId: string; anchorId: string; schedule: Schedule }): Session {
    const day = localDate(new Date(), this.deps.cfg.BOT_TIMEZONE);
    return this.create("brief", {
      guildId: input.guildId,
      channelId: input.channelId,
      threadId: input.anchorId,
      openedBy: null,
      title: `${input.schedule.name} ${day}`,
      scheduleId: input.schedule.id,
    });
  }

  private create(
    kind: Session["kind"],
    input: {
      guildId: string;
      channelId: string;
      threadId: string;
      openedBy: string | null;
      title: string;
      scheduleId: number | null;
    },
  ): Session {
    const { cfg, store } = this.deps;
    const id = randomUUID();
    const title = input.title.slice(0, 100);
    return store.sessions.create({
      id,
      kind,
      guildId: input.guildId,
      channelId: input.channelId,
      threadId: input.threadId,
      // Generated here, so it is durable before the agent subprocess exists.
      agentSessionId: randomUUID(),
      openedBy: input.openedBy,
      title,
      branch: branchName({
        prefix: cfg.GIT_BRANCH_PREFIX,
        title: kind === "brief" ? title.replace(/\s+\d{4}-\d{2}-\d{2}$/, "") : title,
        sessionId: id,
        at: new Date(),
        timeZone: cfg.BOT_TIMEZONE,
      }),
      scheduleId: input.scheduleId,
    });
  }

  abort(sessionId: string): void {
    this.aborted.add(sessionId);
  }

  clearAbort(sessionId: string): void {
    this.aborted.delete(sessionId);
  }

  /**
   * Decides whether the stored SDK session can actually be resumed.
   *
   * A deterministic pre-check beats string-matching an error after the fact:
   * it costs no turns, and a lost transcript is a normal consequence of the
   * volume being replaced rather than an exceptional case.
   */
  private async resolveResume(session: Session, dir: string): Promise<string | null> {
    if (!session.agentSessionId) return null;
    // Asked even on a first turn: a turn that was cut off by a restart leaves a
    // transcript behind without ever having been counted, and resuming it
    // keeps whatever the agent had already worked out.
    try {
      const info = await getSessionInfo(session.agentSessionId, { dir });
      return info ? session.agentSessionId : null;
    } catch {
      return null;
    }
  }

  /** Rebuilds enough context to continue usefully when the transcript is gone. */
  private recapPrefix(sessionId: string): string {
    const turns = this.deps.store.turns.recent(sessionId, 4);
    if (turns.length === 0) return "";
    const lines = [
      "## Earlier in this thread",
      "",
      "Your own record of this conversation was lost. This recap comes from the bot's log of it;",
      "the files in the working directory are exactly as you left them.",
      "",
    ];
    for (const t of turns) {
      lines.push(`- They wrote: ${stripTurnHeader(t.prompt).slice(0, 400)}`);
      lines.push(`  You answered: ${(t.result ?? "").slice(0, 600)}`);
    }
    lines.push("", "---", "");
    return lines.join("\n");
  }

  /**
   * The repository's own instructions, for the system prompt.
   *
   * Claude Code loads a CLAUDE.md by itself. A repository that keeps its
   * instructions in AGENTS.md only gets them if someone hands them over, so
   * the bot does — and stays out of the way when a CLAUDE.md is present, which
   * would otherwise put the same text in the prompt twice.
   */
  private async repoInstructions(dir: string): Promise<string | undefined> {
    const file = this.deps.cfg.REPO_INSTRUCTIONS_FILE;
    if (file.length === 0) return undefined;
    for (const own of ["CLAUDE.md", join(".claude", "CLAUDE.md")]) {
      try {
        await access(join(dir, own));
        return undefined;
      } catch {
        /* not there — keep looking */
      }
    }
    try {
      return await readFile(join(dir, file), "utf8");
    } catch {
      return undefined;
    }
  }

  async runChatTurn(
    req: { session: Session; trigger: TurnTrigger; actorId: string | null; message: ChatMessageContext },
    sink: AgentSink = {},
  ): Promise<TurnResult> {
    return this.execute(
      {
        session: req.session,
        trigger: req.trigger,
        actorId: req.actorId,
        buildPrompt: (turn) => chatUserPrompt(req.message, turn),
        // A brief that someone continued in a thread is a conversation like
        // any other from then on: a person is there, and may ask to ship.
        interactive: true,
      },
      sink,
    );
  }

  async runBriefTurn(session: Session, schedule: Schedule, sink: AgentSink = {}): Promise<TurnResult> {
    return this.execute(
      {
        session,
        trigger: "schedule",
        actorId: null,
        buildPrompt: (turn) => briefUserPrompt(schedule, turn),
        interactive: false,
      },
      sink,
    );
  }

  private async execute(req: ExecuteRequest, sink: AgentSink): Promise<TurnResult> {
    const { cfg, log, store, quota, workspaces, external } = this.deps;
    const session = req.session;

    // Before anything else: refusing here means no turn row, no subprocess, and
    // nothing for restart recovery to reconcile.
    if (quota) {
      const verdict = quota.check();
      if (!verdict.allowed) {
        log.warn({ sessionId: session.id, reason: verdict.reason }, "turn refused by quota guard");
        return { blocked: true, message: explainVerdict(verdict) };
      }
    }

    // Step 2. Without a clone there is nothing for the agent to stand in.
    let dir: string;
    let workspaceCreated: boolean;
    try {
      const ws = await workspaces.ensure(session);
      dir = ws.dir;
      workspaceCreated = ws.created;
    } catch (e) {
      log.error({ err: e, sessionId: session.id }, "could not prepare the workspace");
      return {
        blocked: true,
        message:
          `I couldn't check out the repository for this thread: ${e instanceof Error ? e.message : String(e)}\n` +
          "Nothing was sent to the model.",
      };
    }

    let status: WorkspaceStatus | undefined;
    try {
      status = await workspaces.status(session, { fetch: true });
    } catch (e) {
      log.warn({ err: e, sessionId: session.id }, "could not read workspace status for the turn header");
    }

    const resume = await this.resolveResume(session, dir);
    const contextRebuilt = session.turnCount > 0 && resume === null;
    if (contextRebuilt) {
      log.warn({ sessionId: session.id }, "SDK transcript unavailable — rebuilding context from the store");
    }

    const turn: TurnContext = { now: new Date(), timeZone: cfg.BOT_TIMEZONE, workspace: status };
    const prompt = (contextRebuilt ? this.recapPrefix(session.id) : "") + req.buildPrompt(turn);

    // Step 3 — durable before a token is spent.
    const turnId = store.turns.begin({
      sessionId: session.id,
      trigger: req.trigger,
      actorId: req.actorId,
      prompt,
      resumedFrom: resume,
    });

    // A fresh SDK session needs an id we own; a continuing one needs `resume`.
    const freshId = resume ? null : randomUUID();
    if (freshId) store.sessions.setAgentSession(session.id, freshId);

    const pending: NewToolCall[] = [];
    const polls: PollRequest[] = [];
    let denied = 0;
    let rateLimit: SDKRateLimitInfo | undefined;

    const flush = (): void => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      try {
        store.turns.recordToolCalls(batch);
      } catch (e) {
        log.error({ err: e }, "failed to persist tool audit batch");
      }
    };

    const instructions = await this.repoInstructions(dir);
    const base = status?.base ?? (await workspaces.baseBranch().catch(() => "the base branch"));

    const options = buildOptions({
      cfg,
      log,
      workspaceDir: dir,
      systemAppend: systemAppend({
        repo: cfg.GIT_REPO ?? cfg.GIT_REMOTE_URL ?? "the repository",
        base,
        timeZone: cfg.BOT_TIMEZONE,
        hasSuunto: external.hasSuunto,
        hasLiftosaur: external.hasLiftosaur,
        instructions,
        instructionsFile: cfg.REPO_INSTRUCTIONS_FILE,
      }),
      externalServers: external.servers,
      fitcordServer: createFitcordServer({
        cfg,
        store,
        workspaces,
        session,
        actorId: req.actorId,
        interactive: req.interactive,
        // Only a real Discord id: the dev REPL's "repl" channel is not one.
        defaultChannelId: /^\d{5,25}$/.test(session.channelId) ? session.channelId : undefined,
        requestPoll: (p) => {
          if (polls.length >= POLLS_PER_TURN) return false;
          polls.push(p);
          return true;
        },
        runScheduleNow: this.runScheduleNow,
      }),
      fitcordTools: fitcordToolNames(req.interactive),
      extraEnv: external.env,
      isAborted: () => this.aborted.has(session.id),
      onDecision: (e) => {
        if (!e.decision.allow) denied += 1;
        pending.push({
          turnId,
          sessionId: session.id,
          toolName: e.toolName,
          inputJson: JSON.stringify(e.toolInput ?? null).slice(0, 4000),
          allowed: e.decision.allow,
          denyReason: e.decision.allow ? null : e.decision.reason,
        });
        if (pending.length >= TOOL_FLUSH_EVERY) flush();
      },
      ...(resume ? { resume } : { sessionId: freshId! }),
    });

    const chunks: string[] = [];
    const run = (): Promise<Awaited<ReturnType<typeof runQuery>>> =>
      runQuery(
        prompt,
        options,
        {
          ...sink,
          onText: (t) => {
            chunks.push(t);
            sink.onText?.(t);
          },
          onRateLimit: (info) => {
            rateLimit = info;
            // Feed the guard first: it may set a cooldown that refuses the
            // *next* run before a subprocess is ever spawned.
            quota?.onRateLimit(info);
            sink.onRateLimit?.(info);
          },
        },
        () => this.aborted.has(session.id),
      );

    // The permit is held only around the model call, not the bookkeeping.
    const outcome = quota ? await quota.semaphore.run(run) : await run();

    flush();

    // Keep our record of the SDK session honest if it reported a different id.
    if (outcome.sessionId && outcome.sessionId !== (resume ?? freshId)) {
      log.warn(
        { expected: resume ?? freshId, actual: outcome.sessionId },
        "agent reported a different session id than requested",
      );
      store.sessions.setAgentSession(session.id, outcome.sessionId);
    }

    // Give a newly started SDK session a title. `getSessionInfo` — the check
    // that decides whether a thread can be resumed — only reports sessions it
    // can summarise, and it works that out from the wording of the prompts. A
    // title makes the session findable whatever anyone typed.
    const startedId = resume ? null : (outcome.sessionId ?? freshId);
    if (startedId) {
      await renameSession(startedId, session.title.trim() || "thread", { dir }).catch((e: unknown) =>
        log.warn({ err: e, sessionId: session.id }, "could not title the SDK session"),
      );
    }

    const text = outcome.ok ? outcome.result : chunks.join("");
    const wasAborted = this.aborted.has(session.id);

    // Step 5 — turn state and session counters move together.
    store.turns.finish(turnId, {
      status: outcome.ok ? "ok" : wasAborted ? "aborted" : "error",
      result: outcome.ok ? outcome.result : text || null,
      error: outcome.ok ? null : outcome.error,
      errorSubtype: outcome.ok ? null : (outcome.subtype ?? null),
      numTurns: outcome.numTurns,
      costUsd: outcome.costUsd,
      deniedToolCount: denied,
    });

    this.clearAbort(session.id);

    return {
      blocked: false,
      turnId,
      ok: outcome.ok,
      text: outcome.ok ? outcome.result : `${describeFailure(outcome.error, wasAborted)}${text ? `\n\n${text}` : ""}`,
      numTurns: outcome.numTurns,
      costUsd: outcome.costUsd,
      deniedTools: denied,
      contextRebuilt,
      workspaceCreated,
      // A run that failed part-way may have queued a poll about work it never
      // finished; asking the person to rate that would be noise.
      polls: outcome.ok ? polls : [],
      ...(rateLimit ? { rateLimit } : {}),
    };
  }

  /** Step 6 bookkeeping, once the caller has delivered the answer. */
  markDelivered(turnId: number, messageId: string): void {
    this.deps.store.turns.setDiscordMessage(turnId, messageId);
  }

  /**
   * Boot recovery. Interrupted turns are never retried automatically: the
   * question may be stale, and a restart loop would replay every thread
   * against the quota. The sessions are returned so the bot can say so in
   * each thread instead of leaving a question hanging unanswered.
   */
  recover(): { interrupted: readonly Session[] } {
    const { store, log } = this.deps;
    const orphans = store.turns.running();
    store.turns.markInterrupted(orphans.map((t) => t.id));
    const reset = store.sessions.resetRunning();

    const sessions = [...new Set(orphans.map((t) => t.sessionId))]
      .map((id) => store.sessions.byId(id))
      .filter((s): s is Session => s !== undefined);

    if (orphans.length > 0) {
      log.warn({ interrupted: orphans.length, sessionsReset: reset }, "recovered from an unclean shutdown");
    }
    return { interrupted: sessions };
  }

  /** Removes clones that are idle and hold nothing unshipped. */
  async sweepWorkspaces(): Promise<void> {
    const { store, workspaces } = this.deps;
    await workspaces.sweep((id) => {
      const s = store.sessions.byId(id);
      if (!s) return undefined;
      // A running session is never idle, whatever its timestamps say.
      const lastActiveAt = s.status === "running" ? Date.now() : (s.lastTurnAt ?? s.createdAt);
      return { branch: s.branch, lastActiveAt };
    });
  }
}

function describeFailure(error: string, aborted: boolean): string {
  if (aborted) return "_Stopped._";
  if (/error_max_turns/.test(error)) {
    return "_I ran out of steps before finishing. What I did so far is still in this thread's clone — tell me to continue._";
  }
  return `_The run failed: ${error}_`;
}
