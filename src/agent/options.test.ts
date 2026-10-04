import { describe, expect, it, vi } from "vitest";
import { createSdkMcpServer, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { answerPrompt, buildOptions, BUILTIN_DENY } from "./options.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const ws = "/data/threads/abc";
const signal = new AbortController().signal;
const prompt = { signal, toolUseID: "t1", requestId: "r1" };

async function ask(
  toolName: string,
  input: Record<string, unknown>,
  extra: { decisionReason?: string; blockedPath?: string } = {},
  isAborted?: () => boolean,
): Promise<PermissionResult> {
  const answer = answerPrompt({ log, workspaceDir: ws, ...(isAborted ? { isAborted } : {}) });
  const r = await answer(toolName, input, { ...prompt, ...extra });
  if (!r) throw new Error("canUseTool returned no answer");
  return r;
}

/**
 * The reported failure: a scheduled brief could not edit
 * `.claude/skills/daily-brief/SKILL.md`. Claude Code asks before touching
 * `.claude/`, and with nobody to answer, the old `dontAsk` mode refused.
 * These pin who answers now, and on what terms.
 */
describe("answering Claude Code's permission prompts", () => {
  it.each([
    ".claude/skills/daily-brief/SKILL.md",
    ".claude/skills/daily-brief/scripts/brief_context.py",
    ".claude/settings.json",
    ".claude/scripts/suuntool-session.sh",
    ".claude/agents/coach.md",
    ".claude/commands/brief.md",
    ".mcp.json",
    ".vscode/settings.json",
  ])("says yes to editing %s inside the thread's clone", async (path) => {
    const r = await ask("Edit", { file_path: `${ws}/${path}`, old_string: "a", new_string: "b" }, {
      decisionReason: "sensitive path",
      blockedPath: `${ws}/${path}`,
    });
    expect(r.behavior).toBe("allow");
  });

  it("passes the input through unchanged", async () => {
    const input = { file_path: `${ws}/.claude/skills/x/SKILL.md`, content: "x" };
    expect(await ask("Write", input)).toMatchObject({ behavior: "allow", updatedInput: input });
  });

  it("still says no outside the clone — another thread's work, the database", async () => {
    expect((await ask("Write", { file_path: "/data/threads/def/.claude/settings.json" })).behavior).toBe("deny");
    expect((await ask("Edit", { file_path: "/data/fitcordllm.db" })).behavior).toBe("deny");
  });

  it("still says no inside .git", async () => {
    expect((await ask("Write", { file_path: `${ws}/.git/hooks/pre-push` })).behavior).toBe("deny");
  });

  it("still says no to a push, which only ship may do", async () => {
    const r = await ask("Bash", { command: "git push origin HEAD:master" });
    expect(r).toMatchObject({ behavior: "deny" });
    if (r.behavior === "deny") expect(r.message).toContain("ship");
  });

  it("says no to everything once the run was stopped", async () => {
    const r = await ask("Edit", { file_path: `${ws}/log/x.md` }, {}, () => true);
    expect(r.behavior).toBe("deny");
  });
});

describe("buildOptions", () => {
  const cfg = loadConfig({ DATA_DIR: "/tmp/fitcord-test", GIT_REMOTE_URL: "/tmp/origin.git" } as NodeJS.ProcessEnv);
  const opts = buildOptions({
    cfg,
    log,
    workspaceDir: ws,
    systemAppend: "",
    externalServers: {},
    fitcordServer: createSdkMcpServer({ name: "fitcord", version: "0", tools: [] }),
    sessionId: "00000000-0000-4000-8000-000000000000",
  });

  it("never refuses a prompt for want of a person, and never waits for one", () => {
    // dontAsk turned every sensitive-path prompt into a refusal; that mode
    // must not come back. bypassPermissions would skip canUseTool entirely.
    expect(opts.permissionMode).toBe("default");
    expect(opts.canUseTool).toBeTypeOf("function");
  });

  it("keeps the allow list empty, so every prompt reaches canUseTool", () => {
    // Any bare entry approves its tool before canUseTool is asked.
    expect(opts.allowedTools).toEqual([]);
  });

  it("still removes subagents and WebFetch outright", () => {
    expect(opts.disallowedTools).toEqual([...BUILTIN_DENY]);
    for (const t of BUILTIN_DENY) expect(opts.tools).not.toContain(t);
  });

  it("still loads only the bot's own MCP servers", () => {
    expect(opts.strictMcpConfig).toBe(true);
  });
});
