import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import { FITCORD_SERVER, localStamp } from "../agent/prompts.js";
import type { ShipResult, SyncResult, WorkspaceRef, Workspaces } from "../git/workspaces.js";
import { checkCron } from "../schedule/cron.js";
import type { PollRequest, Schedule } from "../session/types.js";
import type { Store } from "../store/index.js";

/**
 * The bot's own tools, served in-process to the agent.
 *
 * They exist because the things they do need something the agent must not
 * hold. Publishing needs the GitHub token; a schedule has to outlive the
 * conversation that asked for it. So the bot does the work and the model
 * supplies only the intent: a commit message, a cron line, a prompt.
 *
 * A server is built per turn and closes over that turn's session, so there is
 * no session argument for the model to get wrong — `ship` can only ever ship
 * the thread it was called from.
 */

export interface FitcordToolDeps {
  readonly cfg: Config;
  readonly store: Store;
  readonly workspaces: Workspaces;
  readonly session: WorkspaceRef;
  readonly actorId: string | null;
  /**
   * False for a scheduled run. A brief nobody is watching gets the read-only
   * tools and nothing else: the publishing and scheduling tools are not
   * registered at all, rather than registered and trusted not to be called.
   */
  readonly interactive: boolean;
  /**
   * The channel this conversation hangs off. A schedule created here posts
   * there unless told otherwise — "send me a brief every morning", asked in
   * #training, should arrive in #training.
   */
  readonly defaultChannelId?: string | undefined;
  /**
   * Queues a poll to be posted after this turn's reply. Returns false when the
   * turn has already asked for as many as it may.
   */
  readonly requestPoll: (poll: PollRequest) => boolean;
  /** Posts a schedule's brief now. Absent in the dev REPL, which has no channel. */
  readonly runScheduleNow?: ((schedule: Schedule) => void) | undefined;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const failure = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function conflictText(base: string, conflicts: readonly string[], tool: string): string {
  return [
    `Merging ${base} left conflicts in ${conflicts.length} file(s):`,
    ...conflicts.map((c) => `- ${c}`),
    "",
    "Open each file, resolve the conflict markers by editing it so it reads the way it should,",
    `then call \`${tool}\` again. Do not stage or commit anything yourself.`,
  ].join("\n");
}

export function describeSync(r: SyncResult): string {
  if (r.state === "up-to-date") return `This thread already has everything on ${r.base}.`;
  if (r.state === "conflicts") return conflictText(r.base, r.conflicts, "sync");
  if (r.commits.length === 0) return `Merge of ${r.base} concluded. This thread is up to date.`;
  return [
    `Merged ${r.commits.length} commit(s) from ${r.base} into this thread:`,
    ...r.commits.map((c) => `- ${c}`),
  ].join("\n");
}

export function describeShip(r: ShipResult): string {
  if (r.state === "nothing") return `Nothing to ship: this thread has no changes that are not already on ${r.base}.`;
  if (r.state === "conflicts") return conflictText(r.base, r.conflicts, "ship");
  return [
    `Shipped to ${r.base} as commit ${r.sha.slice(0, 10)}. ${r.files.length} file(s):`,
    ...r.files.slice(0, 60).map((f) => `- ${f.replace("\t", " ")}`),
    ...(r.files.length > 60 ? [`- …and ${r.files.length - 60} more`] : []),
  ].join("\n");
}

function describeSchedule(s: Schedule, timeZone: string): string {
  const next = s.nextRunAt ? localStamp(new Date(s.nextRunAt), timeZone) : "never";
  const last = s.lastRunAt ? localStamp(new Date(s.lastRunAt), timeZone) : "not yet";
  return [
    `**${s.name}** — \`${s.cron}\` (${timeZone})${s.enabled ? "" : " — paused"}`,
    `  next: ${next} · last: ${last}${s.channelId ? ` · channel ${s.channelId}` : ""}`,
    `  prompt: ${s.prompt.length > 300 ? `${s.prompt.slice(0, 300)}…` : s.prompt}`,
  ].join("\n");
}

/** Discord's limits on a poll. */
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_OPTION_CHARS = 55;
export const POLL_MAX_QUESTION_CHARS = 300;
/** More than this in one turn is a questionnaire, not a question. */
export const POLLS_PER_TURN = 3;

/** Available in every run, scheduled or not: none of these can publish anything. */
export const READ_TOOL_NAMES = ["workspace_status", "poll"] as const;
export const INTERACTIVE_TOOL_NAMES = [
  "ship",
  "sync",
  "workspace_reset",
  "schedule_list",
  "schedule_set",
  "schedule_delete",
  "schedule_run_now",
] as const;

export function fitcordToolNames(interactive: boolean): string[] {
  const names: string[] = [...READ_TOOL_NAMES, ...(interactive ? INTERACTIVE_TOOL_NAMES : [])];
  return names.map((n) => `mcp__${FITCORD_SERVER}__${n}`);
}

export function createFitcordServer(deps: FitcordToolDeps) {
  const { cfg, store, workspaces, session } = deps;
  const tz = cfg.BOT_TIMEZONE;

  const workspaceStatus = tool(
    "workspace_status",
    "Show how this thread's clone stands against the base branch: which files it has changed and " +
      "not shipped, and how many base-branch commits it has not picked up.",
    {},
    async () => {
      try {
        const s = await workspaces.status(session, { fetch: true });
        const lines = [`Branch \`${s.branch}\`, base \`${s.base}\`.`];
        lines.push(
          s.unshipped.length === 0
            ? "Nothing unshipped."
            : `Unshipped (${s.unshipped.length}):\n${s.unshipped.map((p) => `- ${p}`).join("\n")}`,
        );
        lines.push(
          s.behind === 0
            ? `Up to date with ${s.base}.`
            : `${s.base} has ${s.behind} commit(s) this thread has not picked up.`,
        );
        if (s.merging) {
          lines.push(
            s.conflicts.length > 0
              ? `A merge is unfinished; conflicts remain in: ${s.conflicts.join(", ")}`
              : "A merge is unfinished but fully resolved; `sync` will conclude it.",
          );
        }
        return text(lines.join("\n"));
      } catch (e) {
        return failure(`Could not read the workspace: ${message(e)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const poll = tool(
    "poll",
    "Ask the person a multiple-choice question as a native Discord poll they answer with one tap. " +
      "The poll is posted right after your reply, and their answer arrives later as a new message in " +
      "this conversation. Use it for a rating on a scale, a choice between options you are offering, " +
      "or a yes/no you would otherwise end your message with.",
    {
      key: z
        .string()
        .min(1)
        .max(32)
        .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, dashes and underscores")
        .describe("What the answer is, in a word — `rpe`, `soreness`, `ship`. It comes back with the answer."),
      question: z.string().min(3).max(POLL_MAX_QUESTION_CHARS).describe("The question, as they will read it."),
      options: z
        .array(z.string().min(1).max(POLL_MAX_OPTION_CHARS))
        .min(2)
        .max(POLL_MAX_OPTIONS)
        .describe(
          `Two to ${POLL_MAX_OPTIONS} answers, each at most ${POLL_MAX_OPTION_CHARS} characters, in the order to show them. ` +
            "For a scale, one option per point, lowest first.",
        ),
      multi: z
        .boolean()
        .default(false)
        .describe("True to let them pick several answers — e.g. which muscles are sore."),
    },
    async (a) => {
      if (new Set(a.options).size !== a.options.length) return failure("Not posted: two options are identical.");
      const queued = deps.requestPoll({ key: a.key, question: a.question, options: a.options, multi: a.multi });
      if (!queued) {
        return failure(`Not posted: at most ${POLLS_PER_TURN} polls per reply. Ask the most useful ones first.`);
      }
      return text(
        "Queued. The poll appears directly under your reply, so say in the reply that it is there. " +
          "Do not guess the answer or act as if you have it — it arrives as their next message.",
      );
    },
  );

  if (!deps.interactive) {
    return createSdkMcpServer({ name: FITCORD_SERVER, version: "0.1.0", tools: [workspaceStatus, poll] });
  }

  const ship = tool(
    "ship",
    "Publish this thread's work: commit everything it changed and land it on the base branch as a " +
      "single commit. Call this ONLY when the person's current message asks to push, ship or commit. " +
      "Merges the base branch first if it has moved; reports conflicts for you to resolve.",
    {
      message: z
        .string()
        .min(5)
        .max(5000)
        .describe(
          "The commit message, in the style of the repository's existing history (check `git log`). " +
            "A short subject line; add a body after a blank line only if the change needs explaining.",
        ),
    },
    async (a) => {
      try {
        return text(describeShip(await workspaces.ship(session, a.message)));
      } catch (e) {
        return failure(`Ship failed, and nothing was published: ${message(e)}`);
      }
    },
  );

  const sync = tool(
    "sync",
    "Merge the base branch's latest commits into this thread's branch. Call when the person asks to " +
      "update the thread, or again after resolving the conflicts a previous call reported.",
    {},
    async () => {
      try {
        return text(describeSync(await workspaces.sync(session)));
      } catch (e) {
        return failure(`Sync failed: ${message(e)}`);
      }
    },
  );

  const workspaceReset = tool(
    "workspace_reset",
    "Throw away EVERYTHING this thread has changed and not shipped, and put it back on the base " +
      "branch's current state. Irreversible. Only when the person explicitly asks to discard the work.",
    {
      confirm: z.literal("discard unshipped work").describe("Must be exactly this phrase."),
    },
    async () => {
      try {
        await workspaces.reset(session);
        return text("This thread's unshipped changes are gone; it now matches the base branch.");
      } catch (e) {
        return failure(`Reset failed: ${message(e)}`);
      }
    },
    { annotations: { destructiveHint: true } },
  );

  const scheduleList = tool(
    "schedule_list",
    "List the scheduled briefs.",
    {},
    async () => {
      const all = store.schedules.list(cfg.name);
      if (all.length === 0) return text("No schedules.");
      return text(all.map((s) => describeSchedule(s, tz)).join("\n\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  const scheduleSet = tool(
    "schedule_set",
    "Create a scheduled brief, or replace the one with the same name. On schedule, the prompt is run " +
      "in a fresh conversation and the answer is posted to the channel.",
    {
      name: z
        .string()
        .min(2)
        .max(40)
        .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
        .describe("Short identifier, e.g. `morning-brief`."),
      cron: z
        .string()
        .describe(`Five-field cron in ${tz}: minute hour day-of-month month day-of-week. "0 6 * * *" is 06:00 daily.`),
      prompt: z
        .string()
        .min(10)
        .max(4000)
        .describe(
          "What to produce each time. It runs with no memory of this conversation, so it must stand " +
            "alone: name the skill or files to use and what the message should contain.",
        ),
      channel_id: z
        .string()
        .regex(/^\d{5,25}$/)
        .optional()
        .describe("Discord channel id to post in. Omit to post in the channel this conversation belongs to."),
      enabled: z.boolean().default(true),
    },
    async (a) => {
      const check = checkCron(a.cron, tz, cfg.SCHEDULE_MIN_INTERVAL_MIN);
      if (!check.ok) return failure(`Not scheduled: ${check.reason}.`);
      const saved = store.schedules.upsert({
        profile: cfg.name,
        name: a.name,
        cron: a.cron.trim(),
        prompt: a.prompt,
        channelId: a.channel_id ?? deps.defaultChannelId ?? null,
        enabled: a.enabled,
        createdBy: deps.actorId,
        nextRunAt: a.enabled ? check.next.getTime() : null,
      });
      return text(`Saved.\n\n${describeSchedule(saved, tz)}`);
    },
  );

  const scheduleDelete = tool(
    "schedule_delete",
    "Remove a scheduled brief by name. Briefs it already posted are unaffected.",
    { name: z.string().min(1) },
    async (a) =>
      store.schedules.delete(cfg.name, a.name)
        ? text(`Schedule \`${a.name}\` removed.`)
        : failure(`There is no schedule named \`${a.name}\`.`),
  );

  const scheduleRunNow = tool(
    "schedule_run_now",
    "Post a scheduled brief right now, without changing when it next runs. Use it to test a schedule.",
    { name: z.string().min(1) },
    async (a) => {
      const s = store.schedules.byName(cfg.name, a.name);
      if (!s) return failure(`There is no schedule named \`${a.name}\`.`);
      if (!deps.runScheduleNow) return failure("Briefs can only be posted when the bot is connected to Discord.");
      deps.runScheduleNow(s);
      return text(`Started \`${s.name}\`. It will appear in the brief channel as its own message when it is done.`);
    },
  );

  return createSdkMcpServer({
    name: FITCORD_SERVER,
    version: "0.1.0",
    tools: [
      workspaceStatus,
      poll,
      ship,
      sync,
      workspaceReset,
      scheduleList,
      scheduleSet,
      scheduleDelete,
      scheduleRunNow,
    ],
  });
}
