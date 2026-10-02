import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "./policy.js";

const ws = "/data/threads/abc";
const call = (toolName: string, toolInput: unknown, aborted = false) =>
  evaluate({ toolName, toolInput, workspaceDir: ws, aborted });
const bash = (command: string) => call("Bash", { command });

describe("file edits stay inside the thread's clone", () => {
  it("allows a relative path, resolved against the clone", () => {
    expect(call("Edit", { file_path: "log/2026-10-02.md" }).allow).toBe(true);
  });

  it("allows an absolute path inside the clone", () => {
    expect(call("Write", { file_path: `${ws}/endurance/x.md` }).allow).toBe(true);
  });

  it("refuses another thread's clone", () => {
    // The sibling shares a prefix with this clone's path; a startsWith check
    // would let `/data/threads/abc-other` through.
    expect(call("Write", { file_path: "/data/threads/abc-other/log/x.md" }).allow).toBe(false);
    expect(call("Write", { file_path: "/data/threads/def/log/x.md" }).allow).toBe(false);
  });

  it("refuses climbing out with ..", () => {
    expect(call("Edit", { file_path: "../def/athlete/profile.md" }).allow).toBe(false);
    expect(call("Write", { file_path: `${ws}/../../fitcordllm.db` }).allow).toBe(false);
  });

  it("refuses git's own files", () => {
    expect(call("Write", { file_path: ".git/config" }).allow).toBe(false);
    expect(call("Edit", { file_path: `${ws}/.git/hooks/pre-commit` }).allow).toBe(false);
  });

  it("does not mistake .github or .gitignore for .git", () => {
    expect(call("Edit", { file_path: ".gitignore" }).allow).toBe(true);
    expect(call("Edit", { file_path: ".github/workflows/pages.yml" }).allow).toBe(true);
  });

  it("allows scratch files in the temp directory", () => {
    expect(call("Write", { file_path: join(tmpdir(), "workout.json") }).allow).toBe(true);
  });

  it("refuses a file tool called with no path", () => {
    expect(call("Write", { content: "x" }).allow).toBe(false);
  });
});

describe("git commands that fight the ship/sync model", () => {
  it.each([
    ["git push", "ship"],
    ["git push origin HEAD:master", "ship"],
    ["cd endurance && git commit -am wip", "ship"],
    ["git -C /data/threads/abc push", "ship"],
    ["git -c user.name=x commit -m y", "ship"],
    ["git pull --rebase", "sync"],
    ["git merge origin/master", "sync"],
    ["python3 scripts/verify_plan.py; git push", "ship"],
  ])("refuses `%s` and points at %s", (command, tool) => {
    const d = bash(command);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain(tool);
  });

  it("refuses rebase and remote edits", () => {
    expect(bash("git rebase origin/master").allow).toBe(false);
    expect(bash("git remote set-url origin https://example.com/x.git").allow).toBe(false);
  });

  it.each([
    "git status",
    "git diff --stat",
    "git log --oneline -n 20",
    "git log --grep=push",
    "git show HEAD:log/2026-10-01.md",
    "git checkout -- endurance/2026-10-04-long.md",
    "python3 scripts/verify_plan.py",
    "python3 scripts/pack_guide.py endurance/2026-10-04-long.md --base64",
    "grep -rn 'commit' rules/",
  ])("allows `%s`", (command) => {
    expect(bash(command).allow).toBe(true);
  });
});

describe("stop", () => {
  it("refuses every tool once the run was stopped from Discord", () => {
    expect(call("Read", { file_path: "README.md" }, true).allow).toBe(false);
    expect(call("mcp__suuntool__guides_upload", {}, true).allow).toBe(false);
  });
});

describe("everything else", () => {
  it("leaves other tools to the SDK's allowlist", () => {
    expect(call("Read", { file_path: "/etc/hostname" }).allow).toBe(true);
    expect(call("mcp__fitcord__ship", { message: "log 10-02" }).allow).toBe(true);
  });
});
