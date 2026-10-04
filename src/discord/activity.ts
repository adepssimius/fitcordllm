import { isAbsolute, relative } from "node:path";

/**
 * What the agent is doing, in words, for the live progress message.
 *
 * The first version printed the tool call itself — `Bash command=cd /data/
 * threads/3134e30a-… && python3 scripts/verify_plan.py | tail -3` — which is
 * accurate and tells the person reading it on a phone nothing. What they want
 * is why: "Checking the plan still passes its checks".
 *
 * Two sources, used in turn:
 *
 *  - **The moment a call starts**, `describeToolCall` phrases it from its own
 *    input. Claude Code's Bash tool carries a `description` the model writes
 *    for exactly this purpose, TodoWrite carries the step in progress, and the
 *    file tools are phrased around the file.
 *  - **A few seconds later**, Claude Code emits its own summary of a group of
 *    calls ("Read AGENTS.md & verify_plan.py"). `Activity.summarise` folds the
 *    lines it covers into that one.
 *
 * Pure, so the phrasing is unit tested.
 */

export interface ActivityLine {
  /** The tool calls this line stands for. Empty once nothing can replace it. */
  readonly ids: readonly string[];
  readonly text: string;
}

const MAX_LINE = 90;

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_LINE ? `${one.slice(0, MAX_LINE - 1)}…` : one;
};

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function str(input: unknown, key: string): string | undefined {
  const v = field(input, key);
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/** A path as the person thinks of it: relative to the repository, not the pod. */
export function displayPath(path: string, root?: string): string {
  if (root) {
    const rel = relative(root, path);
    if (rel === "") return "the repository";
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  // Outside the clone (a scratch file in /tmp): the file name is what matters.
  return isAbsolute(path) ? (path.split("/").filter(Boolean).pop() ?? path) : path;
}

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;

/** `workouts_list` → "workouts list". */
const words = (name: string): string => name.replace(/[_-]+/g, " ").trim();

/** Phrases for the tools whose names alone would read as jargon. */
const MCP_PHRASES: Record<string, Record<string, string>> = {
  suuntool: {
    wellness_sleep: "Pulling last night's sleep from Suunto",
    wellness_sleepstages: "Pulling sleep stages from Suunto",
    wellness_recovery: "Pulling recovery data from Suunto",
    wellness_activity: "Pulling daily activity from Suunto",
    workouts_list: "Looking up workouts on Suunto",
    workouts_get: "Opening a workout on Suunto",
    workouts_sml: "Reading a workout's detailed samples",
    workouts_fit: "Downloading a workout file",
    workouts_stats: "Pulling workout statistics from Suunto",
    guides_list: "Checking the guides on the watch",
    guides_upload: "Loading a guide onto the watch",
    guides_update: "Updating a guide on the watch",
    guides_delete: "Removing a guide from the watch",
    guides_download: "Downloading a guide from the watch",
  },
  liftosaur: {
    get_program: "Reading the Liftosaur program",
    update_program: "Updating the Liftosaur program",
    get_history: "Looking up lifting history",
    get_liftoscript_reference: "Checking the Liftoscript reference",
  },
  fitcord: {
    workspace_status: "Checking what this thread has changed",
    sync: "Bringing in the latest from the base branch",
    ship: "Shipping this thread's changes",
    workspace_reset: "Discarding this thread's changes",
    poll: "Preparing a poll",
    schedule_list: "Looking at the schedules",
    schedule_set: "Saving a schedule",
    schedule_delete: "Removing a schedule",
    schedule_run_now: "Starting a scheduled brief",
  },
};

const SERVICE: Record<string, string> = { suuntool: "Suunto", liftosaur: "Liftosaur" };

/** One line saying what a tool call is for. */
export function describeToolCall(name: string, input: unknown, root?: string): string {
  const path = (key = "file_path"): string => {
    const p = str(input, key);
    return p ? code(displayPath(p, root)) : "a file";
  };

  switch (name) {
    case "Bash": {
      // Claude Code asks the model for this description on every Bash call,
      // precisely so a person can see what a command is for.
      const d = str(input, "description");
      return clip(d ?? "Running a command");
    }
    case "Read":
      return clip(`Reading ${path()}`);
    case "Edit":
    case "MultiEdit":
      return clip(`Editing ${path()}`);
    case "Write":
      return clip(`Writing ${path()}`);
    case "NotebookEdit":
      return clip(`Editing ${path("notebook_path")}`);
    case "Glob":
      return clip(`Looking for files matching ${code(str(input, "pattern") ?? "*")}`);
    case "Grep": {
      const where = str(input, "path");
      return clip(
        `Searching for ${code(str(input, "pattern") ?? "")}${where ? ` in ${code(displayPath(where, root))}` : ""}`,
      );
    }
    case "WebSearch":
      return clip(`Searching the web for “${str(input, "query") ?? ""}”`);
    case "Skill":
      return clip(`Using the ${str(input, "skill") ?? str(input, "command") ?? ""} skill`);
    case "TodoWrite": {
      // The step being worked on, in the model's own words.
      const todos = field(input, "todos");
      if (Array.isArray(todos)) {
        const active = todos.find((t) => field(t, "status") === "in_progress");
        const phrase = str(active, "activeForm") ?? str(active, "content");
        if (phrase) return clip(phrase);
      }
      return "Planning the next steps";
    }
  }

  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) {
    const [, server = "", tool = ""] = mcp;
    const known = MCP_PHRASES[server]?.[tool];
    if (known) return known;
    const service = SERVICE[server];
    return clip(service ? `${service}: ${words(tool)}` : words(tool));
  }

  return clip(words(name));
}

/**
 * The running list of activity lines for one turn.
 *
 * A line is added when a call starts and replaced when Claude Code summarises
 * the calls it covers. Repeats collapse — reading three files in a row is
 * three lines, but the same Bash description five times is one.
 */
export class Activity {
  private lines: ActivityLine[] = [];

  add(id: string, text: string): void {
    const last = this.lines[this.lines.length - 1];
    if (last && last.text === text) {
      this.lines[this.lines.length - 1] = { ids: [...last.ids, id], text };
      return;
    }
    this.lines.push({ ids: [id], text });
  }

  /** Replaces the lines covering `ids` with one line, where the first of them stood. */
  summarise(summary: string, ids: readonly string[]): void {
    const covered = new Set(ids);
    const first = this.lines.findIndex((l) => l.ids.some((id) => covered.has(id)));
    if (first === -1) return;
    const kept = this.lines.filter((l, i) => i < first || !l.ids.some((id) => covered.has(id)));
    kept.splice(first, 0, { ids: [], text: clip(summary) });
    this.lines = kept;
  }

  /** The most recent lines, oldest first. */
  recent(n: number): string[] {
    return this.lines.slice(-n).map((l) => l.text);
  }
}
