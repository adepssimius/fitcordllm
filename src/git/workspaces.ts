import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * One clone of the repository per conversation, each on its own branch.
 *
 * The model this implements, in the order the operator meets it:
 *
 *  - A new thread gets a fresh clone of the base branch and a branch of its
 *    own. Nothing the agent does there is visible anywhere else.
 *  - `sync` brings the base branch's latest commits into the thread's branch.
 *  - `ship` publishes: everything the thread changed lands on the base branch
 *    as ONE commit, with the message given. Until then nothing leaves the pod.
 *
 * Shipping squashes on purpose. The thread branch accumulates work-in-progress
 * commits and merges of the base branch — bookkeeping that exists only so a
 * merge has something to merge. None of it is history anyone wants to read, so
 * the base branch gets a single commit whose tree is the thread's tree and
 * whose parent is the base branch's tip. The base branch stays linear and each
 * push is one reviewable commit.
 *
 * This class is also the only place the GitHub token is used. The agent can
 * run `git status` and `git diff` in its clone, but it holds no credential:
 * the remote URL in the clone is plain https, and the token is supplied to the
 * bot's own git calls through the environment, never written to `.git/config`.
 */

const WIP_MESSAGE = "fitcord: work in progress (thread-local, squashed on ship)";

export interface WorkspaceRef {
  /** Session id — the directory name, and so the key the SDK transcript hangs off. */
  readonly id: string;
  readonly branch: string;
}

export interface WorkspaceStatus {
  readonly dir: string;
  readonly branch: string;
  readonly base: string;
  /**
   * Paths that differ from the base branch: committed on the thread branch,
   * edited but uncommitted, or untracked. This is "what `ship` would publish",
   * which is the question the operator is actually asking.
   */
  readonly unshipped: readonly string[];
  /** Commits on the base branch (as last fetched) that this branch lacks. */
  readonly behind: number;
  readonly merging: boolean;
  /** Paths still carrying conflict markers from an unfinished merge. */
  readonly conflicts: readonly string[];
}

export type SyncResult =
  | { readonly state: "up-to-date"; readonly base: string }
  | { readonly state: "merged"; readonly base: string; readonly commits: readonly string[] }
  | { readonly state: "conflicts"; readonly base: string; readonly conflicts: readonly string[] };

export type ShipResult =
  | { readonly state: "nothing"; readonly base: string }
  | { readonly state: "conflicts"; readonly base: string; readonly conflicts: readonly string[] }
  | {
      readonly state: "shipped";
      readonly base: string;
      readonly sha: string;
      /** `git diff --name-status` lines, e.g. `M\tlog/2026-10-02.md`. */
      readonly files: readonly string[];
    };

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export class Workspaces {
  private base: string | undefined;
  /** Serialises mutating operations per workspace. Read by sweep() across instances. */
  readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  /** Which profile this clone set belongs to. */
  get profile(): string {
    return this.cfg.name;
  }

  get configured(): boolean {
    return this.cfg.remoteUrl !== undefined;
  }

  dirFor(sessionId: string): string {
    return join(this.cfg.workspacesDir, sessionId);
  }

  /**
   * Credentials via the environment rather than argv or `.git/config`.
   *
   * Argv is world-readable through `ps`, and a token baked into the clone's
   * remote URL would sit on the volume for the agent to read.
   */
  private gitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: this.cfg.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: this.cfg.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: this.cfg.GIT_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: this.cfg.GIT_AUTHOR_EMAIL,
    };
    if (this.cfg.GITHUB_TOKEN && this.cfg.remoteUrl?.startsWith("https://")) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraHeader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(
        `x-access-token:${this.cfg.GITHUB_TOKEN}`,
      ).toString("base64")}`;
    }
    return env;
  }

  /** Runs git and reports the exit code instead of throwing on a non-zero one. */
  private run(args: readonly string[], cwd?: string): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          env: this.gitEnv(),
          ...(cwd ? { cwd } : {}),
          timeout: this.cfg.GIT_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
            // ENOENT and friends: git itself could not be started.
            reject(err);
            return;
          }
          const code = err ? ((err as { code?: number }).code ?? 1) : 0;
          resolve({ code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
        },
      );
    });
  }

  /** Runs git and throws on failure — for steps with no expected failure mode. */
  private async git(args: readonly string[], cwd?: string): Promise<string> {
    const r = await this.run(args, cwd);
    if (r.code !== 0) {
      throw new GitError(`git ${args[0] ?? ""} failed: ${lastLine(r.stderr) || `exit ${r.code}`}`, r.stderr);
    }
    return r.stdout;
  }

  private async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  private requireRemote(): string {
    if (!this.cfg.remoteUrl) {
      throw new Error("no repository is configured — set GIT_REPO (owner/name) or GIT_REMOTE_URL");
    }
    return this.cfg.remoteUrl;
  }

  /** The branch threads start from and ship to. */
  async baseBranch(): Promise<string> {
    if (this.base) return this.base;
    if (this.cfg.GIT_BASE_BRANCH) {
      this.base = this.cfg.GIT_BASE_BRANCH;
      return this.base;
    }
    // `ref: refs/heads/master\tHEAD` — ask the remote rather than assume "main".
    const out = await this.git(["ls-remote", "--symref", this.requireRemote(), "HEAD"]);
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
    if (!m?.[1]) throw new Error("could not work out the repository's default branch — set GIT_BASE_BRANCH");
    this.base = m[1];
    return this.base;
  }

  async exists(sessionId: string): Promise<boolean> {
    try {
      await access(join(this.dirFor(sessionId), ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Makes sure the session's clone exists, creating it from the base branch's
   * current tip if not.
   *
   * The directory is keyed by session id and never changes. That matters
   * beyond tidiness: the SDK files a transcript under its working directory,
   * so a clone recreated at the same path after a cleanup is still the place
   * the old transcript resumes into.
   */
  async ensure(ws: WorkspaceRef): Promise<{ dir: string; created: boolean }> {
    const dir = this.dirFor(ws.id);
    return this.lock(ws.id, async () => {
      if (await this.exists(ws.id)) return { dir, created: false };

      const remote = this.requireRemote();
      const base = await this.baseBranch();
      await mkdir(this.cfg.workspacesDir, { recursive: true });

      // Clone beside the final path and rename, so a crash mid-clone cannot
      // leave a half-populated directory that `exists` would accept.
      const staging = `${dir}.cloning-${randomBytes(4).toString("hex")}`;
      try {
        await this.git(["clone", "--quiet", "--single-branch", "--branch", base, remote, staging]);
        await this.git(["checkout", "--quiet", "-b", ws.branch], staging);
        await this.git(["config", "user.name", this.cfg.GIT_AUTHOR_NAME], staging);
        await this.git(["config", "user.email", this.cfg.GIT_AUTHOR_EMAIL], staging);
        await rm(dir, { recursive: true, force: true });
        await rename(staging, dir);
      } catch (e) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw e;
      }
      this.log.info({ sessionId: ws.id, branch: ws.branch, base }, "workspace created");
      return { dir, created: true };
    });
  }

  private async fetch(dir: string): Promise<void> {
    await this.git(["fetch", "--quiet", "origin"], dir);
  }

  private async merging(dir: string): Promise<boolean> {
    try {
      await access(join(dir, ".git", "MERGE_HEAD"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Unmerged paths that still contain conflict markers.
   *
   * Git keeps a path "unmerged" until it is `git add`ed, whether or not anyone
   * has fixed the file. The agent resolves a conflict by editing the file —
   * it is never asked to stage anything — so the index cannot tell us what is
   * left. The markers can.
   */
  private async unresolved(dir: string): Promise<string[]> {
    const out = await this.git(["diff", "--name-only", "--diff-filter=U"], dir);
    const paths = out.split("\n").filter((p) => p.length > 0);
    const left: string[] = [];
    for (const p of paths) {
      let text: string;
      try {
        text = await readFile(join(dir, p), "utf8");
      } catch {
        // Deleted on one side: removing or keeping the file is the resolution.
        continue;
      }
      if (/^(<{7}|>{7}) /m.test(text)) left.push(p);
    }
    return left;
  }

  /** Commits whatever is in the working tree to the thread branch. */
  private async commitAll(dir: string, message: string): Promise<void> {
    await this.git(["add", "-A"], dir);
    const staged = await this.run(["diff", "--cached", "--quiet"], dir);
    if (staged.code === 0 && !(await this.merging(dir))) return;
    await this.git(["commit", "--quiet", "--no-verify", "-m", message], dir);
  }

  /**
   * Brings the thread branch to a state that contains the base branch's tip.
   * Returns the paths still in conflict, or an empty list when it does.
   */
  private async absorbBase(dir: string, base: string): Promise<string[]> {
    if (await this.merging(dir)) {
      const left = await this.unresolved(dir);
      if (left.length > 0) return left;
      // Every marker is gone: conclude the merge that was left open.
      await this.git(["add", "-A"], dir);
      await this.git(["commit", "--quiet", "--no-verify", "--no-edit"], dir);
    } else {
      await this.commitAll(dir, WIP_MESSAGE);
    }

    const behind = Number(await this.git(["rev-list", "--count", `HEAD..origin/${base}`], dir));
    if (behind === 0) return [];

    const merge = await this.run(["merge", "--no-edit", "--no-verify", `origin/${base}`], dir);
    if (merge.code === 0) return [];

    const left = await this.unresolved(dir);
    if (left.length === 0 && !(await this.merging(dir))) {
      // Not a conflict — the merge could not start at all.
      throw new GitError(`could not merge ${base}: ${lastLine(merge.stderr || merge.stdout)}`, merge.stderr);
    }
    return left;
  }

  async status(ws: WorkspaceRef, opts: { fetch?: boolean } = {}): Promise<WorkspaceStatus> {
    const dir = this.dirFor(ws.id);
    const base = await this.baseBranch();
    if (opts.fetch) {
      // Best effort: a stale answer about "behind" is better than no answer.
      await this.fetch(dir).catch((e: unknown) => this.log.warn({ err: e }, "fetch failed during status"));
    }

    // --no-optional-locks: this can run while the agent is mid-edit, and
    // taking index.lock for a status would make its own git calls fail.
    const quiet = ["--no-optional-locks"];
    const branch = await this.git([...quiet, "rev-parse", "--abbrev-ref", "HEAD"], dir);
    const mergeBase = await this.git([...quiet, "merge-base", "HEAD", `origin/${base}`], dir);
    const tracked = await this.git([...quiet, "diff", "--name-only", mergeBase], dir);
    const untracked = await this.git([...quiet, "ls-files", "--others", "--exclude-standard"], dir);
    const behind = Number(await this.git([...quiet, "rev-list", "--count", `HEAD..origin/${base}`], dir));
    const merging = await this.merging(dir);

    const unshipped = [...new Set([...tracked.split("\n"), ...untracked.split("\n")])]
      .filter((p) => p.length > 0)
      .sort();

    return {
      dir,
      branch,
      base,
      unshipped,
      behind,
      merging,
      conflicts: merging ? await this.unresolved(dir) : [],
    };
  }

  /** Merges the base branch's latest commits into the thread branch. */
  async sync(ws: WorkspaceRef): Promise<SyncResult> {
    const dir = this.dirFor(ws.id);
    return this.lock(ws.id, async () => {
      const base = await this.baseBranch();
      await this.fetch(dir);

      const wasMerging = await this.merging(dir);
      const before = await this.git(["rev-parse", "HEAD"], dir);
      const incoming = wasMerging
        ? []
        : (await this.git(["log", "--format=%h %s", "-n", "30", `HEAD..origin/${base}`], dir))
            .split("\n")
            .filter((l) => l.length > 0);

      const conflicts = await this.absorbBase(dir, base);
      if (conflicts.length > 0) return { state: "conflicts", base, conflicts };

      const after = await this.git(["rev-parse", "HEAD"], dir);
      if (!wasMerging && incoming.length === 0 && before === after) return { state: "up-to-date", base };
      this.log.info({ sessionId: ws.id, base, commits: incoming.length }, "workspace synced");
      return { state: "merged", base, commits: incoming };
    });
  }

  /**
   * Publishes the thread's work to the base branch as a single commit.
   *
   * The loop exists for one race: the base branch moving between our fetch and
   * our push. The push is never forced, so that surfaces as a rejection, and
   * the answer is to absorb the new commits and try again.
   */
  async ship(ws: WorkspaceRef, message: string): Promise<ShipResult> {
    const dir = this.dirFor(ws.id);
    const text = message.trim();
    if (text.length === 0) throw new Error("a commit message is required");

    return this.lock(ws.id, async () => {
      const base = await this.baseBranch();
      let lastError = "";

      for (let attempt = 0; attempt < 3; attempt++) {
        await this.fetch(dir);

        const conflicts = await this.absorbBase(dir, base);
        if (conflicts.length > 0) return { state: "conflicts", base, conflicts };

        const same = await this.run(["diff", "--quiet", `origin/${base}`, "HEAD"], dir);
        if (same.code === 0) {
          // Nothing of ours is left to publish. Drop the bookkeeping commits so
          // the branch sits exactly on the base branch again.
          await this.git(["reset", "--quiet", "--soft", `origin/${base}`], dir);
          return { state: "nothing", base };
        }

        const parent = await this.git(["rev-parse", `origin/${base}`], dir);
        const sha = await this.git(["commit-tree", "HEAD^{tree}", "-p", parent, "-m", text], dir);

        const push = await this.run(["push", "--quiet", "origin", `${sha}:refs/heads/${base}`], dir);
        if (push.code === 0) {
          const files = (await this.git(["diff", "--name-status", parent, sha], dir))
            .split("\n")
            .filter((l) => l.length > 0);
          // The tree is identical, so a soft reset moves the branch onto the
          // published commit and leaves the working tree clean.
          await this.git(["reset", "--quiet", "--soft", sha], dir);
          await this.git(["update-ref", `refs/remotes/origin/${base}`, sha], dir);
          this.log.warn({ sessionId: ws.id, base, sha, files: files.length }, "shipped to the base branch");
          return { state: "shipped", base, sha, files };
        }

        lastError = push.stderr;
        if (!/non-fast-forward|fetch first|\[rejected\]/i.test(push.stderr)) {
          throw new GitError(`push to ${base} failed: ${lastLine(push.stderr)}`, push.stderr);
        }
        this.log.info({ sessionId: ws.id, attempt }, "base branch moved during ship — retrying");
      }

      throw new GitError(`push to ${base} kept being rejected: ${lastLine(lastError)}`, lastError);
    });
  }

  /** Throws away everything unshipped and puts the branch back on the base branch's tip. */
  async reset(ws: WorkspaceRef): Promise<void> {
    const dir = this.dirFor(ws.id);
    await this.lock(ws.id, async () => {
      const base = await this.baseBranch();
      await this.fetch(dir);
      if (await this.merging(dir)) await this.run(["merge", "--abort"], dir);
      await this.git(["reset", "--quiet", "--hard", `origin/${base}`], dir);
      await this.git(["clean", "--quiet", "-fd"], dir);
      this.log.warn({ sessionId: ws.id }, "workspace reset to the base branch");
    });
  }

  async remove(sessionId: string): Promise<void> {
    await this.lock(sessionId, () => rm(this.dirFor(sessionId), { recursive: true, force: true }));
  }

  /**
   * Deletes clones that are both idle and empty of unshipped work.
   *
   * `lookup` returns the session's branch, when it last ran a turn, and the
   * Workspaces that owns it — several profiles share one clone directory, and
   * "unshipped" means "differs from THAT profile's base branch". Undefined
   * means a directory no session owns, which this instance inspects itself.
   * A clone holding anything unshipped is never deleted here, however old:
   * that work exists nowhere else.
   */
  async sweep(
    lookup: (sessionId: string) => { branch: string; lastActiveAt: number; workspaces?: Workspaces } | undefined,
    now = Date.now(),
  ): Promise<string[]> {
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.cfg.workspacesDir);
    } catch {
      return removed;
    }
    const idleMs = this.cfg.WORKSPACE_IDLE_DAYS * 86_400_000;

    for (const id of entries) {
      if (id.includes(".cloning-")) continue;
      const owner = lookup(id);
      const ws = owner?.workspaces ?? this;
      if (ws.locks.has(id)) continue;
      if (owner && now - owner.lastActiveAt < idleMs) continue;
      if (!(await ws.exists(id))) continue;
      try {
        const st = await ws.status({ id, branch: owner?.branch ?? "" });
        if (st.unshipped.length > 0 || st.merging) continue;
        await ws.remove(id);
        removed.push(id);
      } catch (e) {
        this.log.warn({ err: e, sessionId: id }, "could not inspect a workspace during cleanup");
      }
    }
    if (removed.length > 0) this.log.info({ removed: removed.length }, "idle workspaces removed");
    return removed;
  }
}

function lastLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return (lines[lines.length - 1] ?? "").trim();
}
