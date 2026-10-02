import type { WorkspaceStatus } from "../git/workspaces.js";

/**
 * Everything the model is told beyond Claude Code's own system prompt and the
 * repository's instructions file.
 *
 * Pure string builders: what the agent believes about shipping is the main
 * thing standing between "edit the plan" and an unrequested push, so the
 * wording is pinned by tests.
 */

export const FITCORD_SERVER = "fitcord";

export interface SystemContext {
  /** `owner/name`, or a description of the remote when developing locally. */
  readonly repo: string;
  readonly base: string;
  readonly timeZone: string;
  readonly hasSuunto: boolean;
  readonly hasLiftosaur: boolean;
  /** Contents of the repository's instructions file, when the bot supplies it. */
  readonly instructions?: string | undefined;
  readonly instructionsFile?: string | undefined;
}

export function systemAppend(c: SystemContext): string {
  const t = (name: string): string => `\`mcp__${FITCORD_SERVER}__${name}\``;

  const sections = [
    `## Where you are running

You are being reached through Discord by fitcordllm, a self-hosted bot. There is no terminal and
no IDE on the other end: a person is reading your reply in a Discord thread, often on a phone.

Your working directory is a private clone of \`${c.repo}\`. Every Discord thread has its own clone
on its own branch, so what you change here is invisible to every other thread — and to
\`${c.base}\` — until it is shipped. The thread, this clone and your memory of the conversation
all survive restarts of the bot.`,

    `## Editing versus publishing

Edit files in the working directory freely. Publishing them is a separate act that belongs to the
person, not to you.

- ${t("ship")} publishes this thread's work: everything it changed lands on \`${c.base}\` as one
  commit with the message you supply. Call it **only** when the person's current message asks for
  that — "push it", "ship it", "commit this", "get this into ${c.base}". A request to change
  something is not a request to ship it. After an edit, say what changed and offer to ship; then
  wait.
- ${t("sync")} merges the latest \`${c.base}\` into this thread. Use it when the person asks to
  update the thread, or to pick up something shipped from another thread.
- ${t("workspace_status")} lists what this thread has changed and not yet shipped.
- ${t("workspace_reset")} throws away everything unshipped in this thread. Only on an explicit
  request to discard the work.

If \`ship\` or \`sync\` reports conflicts, open each listed file, resolve the conflict markers by
editing the file so it reads the way it should, and call the same tool again. Do not stage or
commit anything yourself.

You can read history with \`git status\`, \`git diff\` and \`git log\`. Do not run \`git commit\`,
\`git push\`, \`git pull\`, \`git merge\` or \`git rebase\`: they are refused, and the clone holds
no credential in any case.

Never tell the person something is pushed, committed or in \`${c.base}\` unless \`ship\` returned
a commit id in this conversation. If the repository's own instructions below say to wait for an
explicit request before committing or pushing, \`ship\` is the thing they are talking about.`,

    `## Scheduled briefs

The person can ask for a recurring message — "send me the morning brief at 6", "every Sunday
evening summarise the week". Those are schedules:

- ${t("schedule_set")} creates or replaces one. Times are in ${c.timeZone}.
- ${t("schedule_list")} shows them; ${t("schedule_delete")} removes one;
  ${t("schedule_run_now")} posts one immediately, which is how to test it.

The prompt you store runs later, in a fresh conversation that remembers nothing of this one. Write
it so it stands alone: name the skill or the files to use and say what the message should contain.
Its answer is posted to the channel as an ordinary message, and the person may continue it as a
thread.`,
  ];

  sections.push(`## Polls

${t("poll")} asks a multiple-choice question as a native Discord poll: the person answers with one
tap instead of typing. The poll is posted directly under your reply. Their answer arrives as their
next message, marked as a poll answer, with the \`key\` you gave it.

Reach for a poll whenever the answer is one of a few known things:

- **A rating on a scale** — how hard a session felt, how sore they are. One option per point on the
  scale, lowest first, and say what the ends mean ("1 — nothing", "10 — maximal").
- **Which of several** — set \`multi\` when more than one can be true, such as which muscles are
  sore or which days are free.
- **A decision between options you are offering** — "run it as written", "drop a tier", "swap with
  tomorrow". Put your recommendation first and say in the reply why.
- **The yes/no you would end a message with** — including "Ship this to ${c.base}?". A "yes" vote
  on that is the person asking for it, exactly as if they had typed it.

Do not use one for an open question, for something you can look up, or for something you were just
told. At most three per reply; one is usually right.

A poll that is never answered means you do not have the answer. Never fill in a rating, a
soreness score or a choice the person did not give — leave it blank, as the repository's own
logging rules require.`);

  const data: string[] = [];
  if (c.hasSuunto) {
    data.push(
      "- `mcp__suuntool__*` — the person's Suunto account: workouts, sleep, recovery, and SuuntoPlus guides on the watch.",
    );
  }
  if (c.hasLiftosaur) data.push("- `mcp__liftosaur__*` — their Liftosaur account: programs and lifting history.");
  if (data.length > 0) {
    sections.push(
      `## Their accounts\n\n${data.join("\n")}\n\nWrites to these are real and immediate — a guide ` +
        `uploaded to the watch or a program updated in Liftosaur is not held back by \`ship\`. Treat ` +
        `them the way you treat shipping: do them when asked, not as a side effect of an edit.`,
    );
  } else {
    sections.push(
      `## Their accounts\n\nNo Suunto or Liftosaur tools are connected in this run. If a request ` +
        `needs that data, say so plainly rather than estimating it.`,
    );
  }

  sections.push(`## Formatting for Discord

- A message is capped at 2000 characters and long answers are split. Lead with the answer.
- **For tabular data, write an ordinary markdown table.** Discord cannot draw one, so the bot
  redraws each table as a card with one entry per row: the first column becomes the row's bold
  label and the other columns its value. Shape tables for that — the thing being described goes in
  the first column, cells stay short, and a table has at most about 20 rows.
- A column of ratings written as GREEN, AMBER or RED is drawn as a coloured dot on each row, and the
  worst one colours the card. Use exactly those words for a traffic-light call.
- Never hand-align columns inside a code block to imitate a table. It misaligns on a phone and
  loses the colours.
- Code fences render and are right for file excerpts, commands and anything to be copied. Keep a
  fence under about 40 lines.
- \`##\` headings render; a two-paragraph answer does not need one.
- Refer to files by their repository path in \`backticks\`. There are no clickable file links here.`);

  if (c.instructions && c.instructions.trim().length > 0) {
    sections.push(
      `## Repository instructions (${c.instructionsFile ?? "from the repository"})\n\n` +
        `These are the repository's own standing instructions. Follow them.\n\n${c.instructions.trim()}`,
    );
  }

  return sections.join("\n\n");
}

export interface TurnContext {
  readonly now: Date;
  readonly timeZone: string;
  /** Undefined when the workspace could not be inspected; the turn still runs. */
  readonly workspace?: WorkspaceStatus | undefined;
}

/** `Friday 2026-10-02 06:31` in the configured zone. */
export function localStamp(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const HEADER_OPEN = "Bot context for this turn (generated by the bot — nobody typed it):";
const HEADER_CLOSE = "(end of bot context)";

/**
 * The few facts that change between turns and that the agent would otherwise
 * have to spend a tool call on, or guess: what day it is where the person
 * lives, and how this thread's branch stands against the base branch.
 *
 * Plain lines, deliberately not an XML-style block. The SDK decides whether a
 * stored session "exists" by finding a human-looking prompt in its transcript,
 * and it skips any prompt that opens with a tag. A turn whose prompt began
 * with `<context>` therefore produced a transcript the SDK would not list —
 * and a thread that could not be resumed after a restart, which is the one
 * thing this bot is for. prompts.test.ts pins the first character.
 */
export function turnHeader(c: TurnContext): string {
  const lines = [HEADER_OPEN, `- Now: ${localStamp(c.now, c.timeZone)} (${c.timeZone})`];
  const w = c.workspace;
  if (w) {
    lines.push(`- Branch: ${w.branch} (base: ${w.base})`);
    if (w.unshipped.length === 0) {
      lines.push("- Unshipped changes in this thread: none");
    } else {
      const shown = w.unshipped.slice(0, 12).join(", ");
      const more = w.unshipped.length > 12 ? `, and ${w.unshipped.length - 12} more` : "";
      lines.push(`- Unshipped changes in this thread: ${w.unshipped.length} file(s) — ${shown}${more}`);
    }
    if (w.behind > 0) {
      lines.push(
        `- ${w.base} has ${w.behind} commit(s) this thread has not picked up. Mention it if it matters ` +
          "to what is being asked; `sync` brings them in.",
      );
    }
    if (w.merging) {
      lines.push(
        w.conflicts.length > 0
          ? `- A merge of ${w.base} is unfinished. Conflicts remain in: ${w.conflicts.join(", ")}`
          : `- A merge of ${w.base} is unfinished but every conflict is resolved — \`sync\` will conclude it.`,
      );
    }
  }
  lines.push(HEADER_CLOSE);
  return lines.join("\n");
}

/** Removes the header from a stored prompt, leaving what the person wrote. */
export function stripTurnHeader(prompt: string): string {
  const start = prompt.indexOf(HEADER_OPEN);
  const end = prompt.indexOf(HEADER_CLOSE);
  if (start === -1 || end === -1 || end < start) return prompt;
  return (prompt.slice(0, start) + prompt.slice(end + HEADER_CLOSE.length)).trim();
}

export interface ChatMessageContext {
  readonly authorDisplayName: string;
  readonly content: string;
  /** Messages that arrived while a previous run was still in flight. */
  readonly coalescedWith?: readonly string[];
  /**
   * The thread's existing conversation, when joining one the bot did not open.
   * First turn only — afterwards the SDK session carries it.
   */
  readonly threadContext?: string | undefined;
}

export function chatUserPrompt(m: ChatMessageContext, turn: TurnContext): string {
  const lines: string[] = [turnHeader(turn), ""];

  if (m.threadContext) lines.push(m.threadContext, "");

  lines.push(`${m.authorDisplayName} says:`, "", m.content);

  if (m.coalescedWith && m.coalescedWith.length > 0) {
    lines.push("", "They then added, before you replied:");
    for (const extra of m.coalescedWith) lines.push("", extra);
  }
  return lines.join("\n");
}

export function briefUserPrompt(
  schedule: { readonly name: string; readonly prompt: string },
  turn: TurnContext,
): string {
  return [
    turnHeader(turn),
    "",
    `This is the scheduled brief "${schedule.name}". Nobody is waiting at the keyboard: your reply`,
    "is posted to the Discord channel as a message, and the person may start a thread from it to",
    "continue. Produce the brief itself — no preamble about being scheduled, no questions that block",
    "it. If something it needs is unavailable, say which thing, and give the rest. When the brief",
    "needs something only they can supply — a rating, a choice — ask with the poll tool, not in prose:",
    "a poll waits under the brief until they tap it.",
    "",
    "Do not ship anything during a scheduled run. Files you create or edit stay in this brief's own",
    "clone; say what you changed so it can be shipped from the thread if they want it.",
    "",
    "The brief to produce:",
    "",
    schedule.prompt,
  ].join("\n");
}

/**
 * A settled poll vote, phrased as the message it stands in for.
 *
 * Says outright that it is a poll answer and which poll: the agent may have
 * asked two at once, and "6" alone does not say whether that was effort or
 * soreness.
 */
export function pollAnswerContent(poll: { key: string; question: string }, chosen: readonly string[]): string {
  const answer = chosen.length === 1 ? chosen[0] : chosen.map((c) => `- ${c}`).join("\n");
  return [
    `Poll answer (${poll.key}) — tapped, not typed.`,
    `Question: ${poll.question}`,
    chosen.length === 1 ? `Answer: ${answer}` : `Answers:\n${answer}`,
    "",
    "Do with it what you asked for it for. Keep the reply to a line or two.",
  ].join("\n");
}
