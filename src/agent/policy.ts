import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The runtime gate on tool calls. Pure, so every rule is unit tested.
 *
 * What this is and is not. The agent here has Bash and can edit files — that
 * is the job — so this is not the boundary that keeps the base branch safe.
 * That boundary is that the agent holds no git credential: the clone's remote
 * is plain https and the token lives only in the bot process (git/workspaces.ts).
 *
 * This gate does two narrower things:
 *  - keeps file edits inside the thread's own clone, so one thread cannot
 *    scribble on another's work or on the bot's database;
 *  - turns the git commands that would fight the ship/sync model into a clear
 *    refusal naming the tool to use instead, rather than a confusing failure
 *    three steps later.
 *
 * A regex over a shell string is not a security control and is not used as one.
 */

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface PolicyInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** Absolute path of this thread's clone. */
  readonly workspaceDir: string;
  readonly aborted?: boolean;
}

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * git subcommands that publish or rewrite branch state. `-C dir`, `-c k=v` and
 * `--no-pager` style options may sit between `git` and the subcommand.
 */
const GIT_WRITE =
  /(?:^|[\s;&|(`])git\b(?:\s+-{1,2}[\w-]+(?:[= ](?!push|pull|commit|merge|rebase|remote)\S+)?)*\s+(push|pull|commit|merge|rebase|remote)\b/;

const GIT_ADVICE: Record<string, string> = {
  push: "publishing goes through the `ship` tool, and only when the person asks for it",
  commit: "do not commit by hand — `ship` commits and publishes when the person asks for it",
  pull: "use the `sync` tool to bring in the base branch",
  merge: "use the `sync` tool to bring in the base branch",
  rebase: "this thread's branch is squashed on `ship`; there is nothing to rebase",
  remote: "the clone's remote is managed by the bot",
};

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fieldString(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export function evaluate(i: PolicyInput): Decision {
  if (i.aborted) return deny("this run was stopped from Discord");

  if (FILE_TOOLS.has(i.toolName)) {
    const raw = fieldString(i.toolInput, "file_path") ?? fieldString(i.toolInput, "notebook_path");
    if (!raw) return deny(`${i.toolName} was called without a file path`);

    const target = resolve(i.workspaceDir, raw);
    const scratch = resolve(tmpdir());
    if (!inside(i.workspaceDir, target) && !inside(scratch, target)) {
      return deny(`'${raw}' is outside this thread's clone — edits stay inside ${i.workspaceDir}`);
    }
    if (inside(resolve(i.workspaceDir, ".git"), target)) {
      return deny(`'${raw}' is inside .git — git's own files are not edited by hand`);
    }
    return ALLOW;
  }

  if (i.toolName === "Bash") {
    const command = fieldString(i.toolInput, "command") ?? "";
    const m = GIT_WRITE.exec(command);
    if (m?.[1]) return deny(`\`git ${m[1]}\` is not run directly here: ${GIT_ADVICE[m[1]] ?? "use the fitcord tools"}`);
    return ALLOW;
  }

  return ALLOW;
}

/** Exposed for tests: the directory separator makes path fixtures platform-shaped. */
export const PATH_SEP = sep;
