import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCore } from "../config.js";
import type { Logger } from "../logger.js";
import { Workspaces, type WorkspaceRef } from "./workspaces.js";

/**
 * Real git against a bare repository on disk. The whole point of this module
 * is what ends up on the base branch, and a mock of git would only confirm
 * that the commands were typed the way they were typed.
 */

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const IDENTITY = ["-c", "user.name=seed", "-c", "user.email=seed@example.invalid"];

let root: string;
let origin: string;
let workspaces: Workspaces;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();
}

/** What a reader of the base branch sees: subjects, newest first. */
function baseLog(): string[] {
  return git(origin, "log", "--format=%s", "master").split("\n");
}

function baseFile(path: string): string {
  return git(origin, "show", `master:${path}`);
}

const thread = (id: string): WorkspaceRef => ({ id, branch: `fitcord/${id}` });

function write(ws: WorkspaceRef, path: string, content: string): void {
  const full = join(workspaces.dirFor(ws.id), path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function read(ws: WorkspaceRef, path: string): string {
  return readFileSync(join(workspaces.dirFor(ws.id), path), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fitcord-ws-"));
  origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=master", origin]);

  const seed = join(root, "seed");
  execFileSync("git", ["clone", "--quiet", origin, seed], { stdio: "ignore" });
  mkdirSync(join(seed, "log"));
  writeFileSync(join(seed, "plan.md"), "week 14: easy\n");
  writeFileSync(join(seed, "log", "2026-10-01.md"), "rpe: 4\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", "origin", "HEAD:master");

  const cfg = loadCore({ DATA_DIR: join(root, "data"), GIT_REMOTE_URL: origin } as NodeJS.ProcessEnv);
  workspaces = new Workspaces(cfg, silentLog);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a new thread", () => {
  it("finds the base branch from the remote rather than assuming main", async () => {
    expect(await workspaces.baseBranch()).toBe("master");
  });

  it("gets a fresh clone on its own branch", async () => {
    const a = thread("a");
    const made = await workspaces.ensure(a);
    expect(made.created).toBe(true);
    expect(read(a, "plan.md")).toBe("week 14: easy\n");

    const st = await workspaces.status(a);
    expect(st.branch).toBe("fitcord/a");
    expect(st.base).toBe("master");
    expect(st.unshipped).toEqual([]);
    expect(st.behind).toBe(0);
  });

  it("reuses the clone on later turns instead of re-cloning over the work", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    write(a, "plan.md", "week 14: hard\n");
    expect((await workspaces.ensure(a)).created).toBe(false);
    expect(read(a, "plan.md")).toBe("week 14: hard\n");
  });

  it("is invisible to other threads", async () => {
    const a = thread("a");
    const b = thread("b");
    await workspaces.ensure(a);
    await workspaces.ensure(b);
    write(a, "plan.md", "changed in a\n");
    expect(read(b, "plan.md")).toBe("week 14: easy\n");
  });
});

describe("status", () => {
  it("counts edits and new files as unshipped", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    write(a, "plan.md", "week 14: hard\n");
    write(a, "log/2026-10-02.md", "rpe: 6\n");
    expect((await workspaces.status(a)).unshipped).toEqual(["log/2026-10-02.md", "plan.md"]);
  });
});

describe("ship", () => {
  it("lands the thread's work on the base branch as one commit", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    write(a, "plan.md", "week 14: hard\n");
    write(a, "log/2026-10-02.md", "rpe: 6\n");

    const r = await workspaces.ship(a, "log 10-02: tempo felt hard");
    expect(r.state).toBe("shipped");
    if (r.state !== "shipped") return;

    expect(baseLog()).toEqual(["log 10-02: tempo felt hard", "seed"]);
    expect(git(origin, "rev-parse", "master")).toBe(r.sha);
    expect(baseFile("log/2026-10-02.md")).toBe("rpe: 6");
    expect(r.files).toEqual(["A\tlog/2026-10-02.md", "M\tplan.md"]);

    const st = await workspaces.status(a);
    expect(st.unshipped).toEqual([]);
    expect(st.behind).toBe(0);
  });

  it("publishes nothing until asked", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    write(a, "plan.md", "week 14: hard\n");
    await workspaces.status(a, { fetch: true });
    await workspaces.sync(a);
    expect(baseLog()).toEqual(["seed"]);
  });

  it("reports nothing to ship rather than pushing an empty commit", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    expect((await workspaces.ship(a, "nothing here")).state).toBe("nothing");
    expect(baseLog()).toEqual(["seed"]);
  });

  it("can ship again after shipping", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    write(a, "plan.md", "v2\n");
    await workspaces.ship(a, "first");
    write(a, "plan.md", "v3\n");
    await workspaces.ship(a, "second");
    expect(baseLog()).toEqual(["second", "first", "seed"]);
    expect(baseFile("plan.md")).toBe("v3");
  });

  it("merges in work another thread shipped first, and stays one commit", async () => {
    const a = thread("a");
    const b = thread("b");
    await workspaces.ensure(a);
    await workspaces.ensure(b);

    write(a, "plan.md", "week 14: hard\n");
    await workspaces.ship(a, "plan: harden week 14");

    write(b, "log/2026-10-02.md", "rpe: 6\n");
    const r = await workspaces.ship(b, "log 10-02");
    expect(r.state).toBe("shipped");

    expect(baseLog()).toEqual(["log 10-02", "plan: harden week 14", "seed"]);
    // b's commit carries only b's file; a's change arrived as a's commit.
    if (r.state === "shipped") expect(r.files).toEqual(["A\tlog/2026-10-02.md"]);
    expect(baseFile("plan.md")).toBe("week 14: hard");
  });

  it("keeps the base branch linear — no merge or work-in-progress commits reach it", async () => {
    const a = thread("a");
    const b = thread("b");
    await workspaces.ensure(a);
    await workspaces.ensure(b);

    write(b, "log/2026-10-02.md", "rpe: 6\n");
    write(a, "plan.md", "week 14: hard\n");
    await workspaces.ship(a, "plan change");
    await workspaces.sync(b); // leaves a local WIP commit and a merge commit on b
    write(b, "log/2026-10-02.md", "rpe: 7\n");
    await workspaces.ship(b, "log 10-02");

    expect(baseLog()).toEqual(["log 10-02", "plan change", "seed"]);
    expect(git(origin, "rev-list", "--merges", "--count", "master")).toBe("0");
  });

  it("refuses an empty message", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    write(a, "plan.md", "x\n");
    await expect(workspaces.ship(a, "   ")).rejects.toThrow(/message/);
  });
});

describe("sync", () => {
  it("brings the base branch's new commits into the thread", async () => {
    const a = thread("a");
    const b = thread("b");
    await workspaces.ensure(a);
    await workspaces.ensure(b);

    write(a, "plan.md", "week 14: hard\n");
    await workspaces.ship(a, "plan: harden week 14");

    expect((await workspaces.status(b, { fetch: true })).behind).toBe(1);
    const r = await workspaces.sync(b);
    expect(r.state).toBe("merged");
    if (r.state === "merged") expect(r.commits.join("\n")).toContain("plan: harden week 14");
    expect(read(b, "plan.md")).toBe("week 14: hard\n");
    expect((await workspaces.status(b)).behind).toBe(0);
  });

  it("keeps the thread's own uncommitted edits through a sync", async () => {
    const a = thread("a");
    const b = thread("b");
    await workspaces.ensure(a);
    await workspaces.ensure(b);

    write(b, "log/2026-10-02.md", "rpe: 6\n");
    write(a, "plan.md", "week 14: hard\n");
    await workspaces.ship(a, "plan change");
    await workspaces.sync(b);

    expect(read(b, "log/2026-10-02.md")).toBe("rpe: 6\n");
    // Still unshipped, and only b's own file — not the commit it just merged.
    expect((await workspaces.status(b)).unshipped).toEqual(["log/2026-10-02.md"]);
  });

  it("says so when there is nothing new", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    expect((await workspaces.sync(a)).state).toBe("up-to-date");
  });
});

describe("conflicts", () => {
  async function conflicted(): Promise<{ a: WorkspaceRef; b: WorkspaceRef }> {
    const a = thread("a");
    const b = thread("b");
    await workspaces.ensure(a);
    await workspaces.ensure(b);
    write(a, "plan.md", "week 14: hard\n");
    await workspaces.ship(a, "a's version");
    write(b, "plan.md", "week 14: rest\n");
    return { a, b };
  }

  it("reports the files and leaves them for the agent to resolve", async () => {
    const { b } = await conflicted();
    const r = await workspaces.sync(b);
    expect(r).toMatchObject({ state: "conflicts", conflicts: ["plan.md"] });
    expect(read(b, "plan.md")).toContain("<<<<<<<");

    const st = await workspaces.status(b);
    expect(st.merging).toBe(true);
    expect(st.conflicts).toEqual(["plan.md"]);
  });

  it("keeps reporting the conflict until the markers are gone", async () => {
    const { b } = await conflicted();
    await workspaces.sync(b);
    expect((await workspaces.sync(b)).state).toBe("conflicts");
    expect((await workspaces.ship(b, "too early")).state).toBe("conflicts");
    expect(baseLog()).toEqual(["a's version", "seed"]);
  });

  it("concludes the merge once the file is edited, with no git commands from the agent", async () => {
    const { b } = await conflicted();
    await workspaces.sync(b);
    write(b, "plan.md", "week 14: hard, then rest\n");

    expect((await workspaces.sync(b)).state).toBe("merged");
    expect((await workspaces.status(b)).merging).toBe(false);

    const r = await workspaces.ship(b, "b's version, reconciled");
    expect(r.state).toBe("shipped");
    expect(baseFile("plan.md")).toBe("week 14: hard, then rest");
    expect(baseLog()).toEqual(["b's version, reconciled", "a's version", "seed"]);
  });

  it("can resolve straight through ship", async () => {
    const { b } = await conflicted();
    expect((await workspaces.ship(b, "b")).state).toBe("conflicts");
    write(b, "plan.md", "week 14: rest\n");
    expect((await workspaces.ship(b, "b")).state).toBe("shipped");
    expect(baseFile("plan.md")).toBe("week 14: rest");
  });
});

describe("reset", () => {
  it("throws away unshipped work, including an unfinished merge", async () => {
    const a = thread("a");
    const b = thread("b");
    await workspaces.ensure(a);
    await workspaces.ensure(b);
    write(a, "plan.md", "week 14: hard\n");
    await workspaces.ship(a, "a");
    write(b, "plan.md", "week 14: rest\n");
    write(b, "scratch.md", "notes\n");
    await workspaces.sync(b);

    await workspaces.reset(b);
    expect(read(b, "plan.md")).toBe("week 14: hard\n");
    expect(existsSync(join(workspaces.dirFor("b"), "scratch.md"))).toBe(false);
    const st = await workspaces.status(b);
    expect(st).toMatchObject({ unshipped: [], merging: false, behind: 0 });
  });
});

describe("sweep", () => {
  const long = 365 * 86_400_000;

  it("removes an idle clone that holds nothing unshipped", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    const removed = await workspaces.sweep(() => ({ branch: a.branch, lastActiveAt: Date.now() - long }));
    expect(removed).toEqual(["a"]);
    expect(await workspaces.exists("a")).toBe(false);
  });

  it("never removes a clone with unshipped work, however old", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    write(a, "log/2026-10-02.md", "rpe: 6\n");
    const removed = await workspaces.sweep(() => ({ branch: a.branch, lastActiveAt: Date.now() - long }));
    expect(removed).toEqual([]);
    expect(read(a, "log/2026-10-02.md")).toBe("rpe: 6\n");
  });

  it("leaves a recently used clone alone", async () => {
    const a = thread("a");
    await workspaces.ensure(a);
    expect(await workspaces.sweep(() => ({ branch: a.branch, lastActiveAt: Date.now() }))).toEqual([]);
  });

  it("recreates a swept clone at the same path, from the current base branch", async () => {
    const a = thread("a");
    const b = thread("b");
    await workspaces.ensure(a);
    const dir = workspaces.dirFor("a");
    await workspaces.sweep(() => ({ branch: a.branch, lastActiveAt: Date.now() - long }));

    await workspaces.ensure(b);
    write(b, "plan.md", "week 15\n");
    await workspaces.ship(b, "week 15");

    const again = await workspaces.ensure(a);
    expect(again).toEqual({ dir, created: true });
    expect(read(a, "plan.md")).toBe("week 15\n");
  });
});
