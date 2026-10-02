import { describe, expect, it } from "vitest";
import type { WorkspaceStatus } from "../git/workspaces.js";
import { describeShip, describeSync, fitcordToolNames } from "../tools/fitcord.js";
import {
  briefUserPrompt,
  chatUserPrompt,
  localStamp,
  stripTurnHeader,
  systemAppend,
  turnHeader,
} from "./prompts.js";

const sys = (over: Partial<Parameters<typeof systemAppend>[0]> = {}) =>
  systemAppend({
    repo: "someone/training",
    base: "master",
    timeZone: "America/New_York",
    hasSuunto: true,
    hasLiftosaur: true,
    ...over,
  });

const status = (over: Partial<WorkspaceStatus> = {}): WorkspaceStatus => ({
  dir: "/data/threads/abc",
  branch: "fitcord/2026-10-02-long-run-abc123",
  base: "master",
  unshipped: [],
  behind: 0,
  merging: false,
  conflicts: [],
  ...over,
});

const now = new Date("2026-10-02T10:31:00Z");

describe("system prompt", () => {
  it("names the real base branch, so 'main' is never guessed", () => {
    expect(sys()).toContain("lands on `master`");
    expect(sys({ base: "main" })).toContain("lands on `main`");
  });

  it("separates editing from publishing", () => {
    const p = sys();
    expect(p).toContain("A request to change\n  something is not a request to ship it");
    expect(p).toContain("offer to ship; then\n  wait");
  });

  it("forbids claiming a push that did not happen", () => {
    expect(sys()).toContain("unless `ship` returned\na commit id");
  });

  it("says account writes are not held back by ship", () => {
    expect(sys()).toContain("is not held back by `ship`");
  });

  it("admits it when the account tools are missing instead of implying them", () => {
    const p = sys({ hasSuunto: false, hasLiftosaur: false });
    expect(p).toContain("No Suunto or Liftosaur tools are connected");
    expect(p).not.toContain("mcp__suuntool__");
  });

  it("carries the repository's instructions when given them", () => {
    const p = sys({ instructions: "Make the edit and stop.", instructionsFile: "AGENTS.md" });
    expect(p).toContain("## Repository instructions (AGENTS.md)");
    expect(p).toContain("Make the edit and stop.");
  });

  it("adds no empty instructions section", () => {
    expect(sys({ instructions: "   " })).not.toContain("Repository instructions");
  });
});

describe("turn header", () => {
  it("states the local day, which is what 'today's session' depends on", () => {
    // 10:31 UTC is 06:31 in New York — and still Friday there.
    expect(localStamp(now, "America/New_York")).toBe("Friday 2026-10-02 06:31");
    expect(localStamp(new Date("2026-10-03T02:00:00Z"), "America/New_York")).toBe("Friday 2026-10-02 22:00");
  });

  it("reports a clean thread plainly", () => {
    const h = turnHeader({ now, timeZone: "UTC", workspace: status() });
    expect(h).toContain("Unshipped changes in this thread: none");
    expect(h).not.toContain("has not picked up");
  });

  it("lists what is unshipped and how far behind the thread is", () => {
    const h = turnHeader({
      now,
      timeZone: "UTC",
      workspace: status({ unshipped: ["log/2026-10-02.md", "plan.md"], behind: 3 }),
    });
    expect(h).toContain("2 file(s) — log/2026-10-02.md, plan.md");
    expect(h).toContain("master has 3 commit(s) this thread has not picked up");
  });

  it("caps a long file list", () => {
    const many = Array.from({ length: 20 }, (_, i) => `endurance/${i}.md`);
    expect(turnHeader({ now, timeZone: "UTC", workspace: status({ unshipped: many }) })).toContain("and 8 more");
  });

  it("still produces a header when the workspace could not be read", () => {
    expect(turnHeader({ now, timeZone: "UTC" })).toContain("Now: Friday 2026-10-02 10:31 (UTC)");
  });
});

describe("user prompts", () => {
  it("puts the header before the message and folds in follow-ups", () => {
    const p = chatUserPrompt(
      { authorDisplayName: "sam", content: "move Saturday's long run", coalescedWith: ["to Sunday"] },
      { now, timeZone: "UTC", workspace: status() },
    );
    expect(p.indexOf("Bot context for this turn")).toBeLessThan(p.indexOf("sam says:"));
    expect(p).toContain("They then added, before you replied:\n\nto Sunday");
  });

  it("never opens a prompt with a tag, or the thread cannot be resumed after a restart", () => {
    // The SDK lists a stored session only if it finds a human-looking prompt
    // in the transcript, and skips prompts that start with `<`. A header that
    // began with <context> made every thread unresumable. Found by restarting
    // the REPL mid-conversation; pinned here.
    const turn = { now, timeZone: "UTC", workspace: status() };
    expect(chatUserPrompt({ authorDisplayName: "sam", content: "hi" }, turn).trimStart()[0]).not.toBe("<");
    expect(briefUserPrompt({ name: "b", prompt: "p" }, turn).trimStart()[0]).not.toBe("<");
  });

  it("can take the header back off a stored prompt", () => {
    const turn = { now, timeZone: "UTC", workspace: status({ unshipped: ["plan.md"] }) };
    const p = chatUserPrompt({ authorDisplayName: "sam", content: "move the long run" }, turn);
    expect(stripTurnHeader(p)).toBe("sam says:\n\nmove the long run");
  });

  it("tells a scheduled run not to ship", () => {
    const p = briefUserPrompt({ name: "morning-brief", prompt: "Run the daily brief." }, { now, timeZone: "UTC" });
    expect(p).toContain("Do not ship anything during a scheduled run");
    expect(p.endsWith("Run the daily brief.")).toBe(true);
  });
});

describe("tool surface", () => {
  it("gives a scheduled run no way to publish or to schedule", () => {
    const names = fitcordToolNames(false);
    expect(names).toEqual(["mcp__fitcord__workspace_status"]);
  });

  it("gives a conversation ship, sync and the schedule tools", () => {
    const names = fitcordToolNames(true);
    expect(names).toContain("mcp__fitcord__ship");
    expect(names).toContain("mcp__fitcord__sync");
    expect(names).toContain("mcp__fitcord__schedule_set");
  });
});

describe("tool results", () => {
  it("reports a ship with the commit and the files", () => {
    const out = describeShip({
      state: "shipped",
      base: "master",
      sha: "0123456789abcdef0123",
      files: ["A\tlog/2026-10-02.md", "M\tplan.md"],
    });
    expect(out).toContain("Shipped to master as commit 0123456789");
    expect(out).toContain("- A log/2026-10-02.md");
  });

  it("tells the agent how to get out of a conflict without git", () => {
    const out = describeSync({ state: "conflicts", base: "master", conflicts: ["plan.md"] });
    expect(out).toContain("- plan.md");
    expect(out).toContain("call `sync` again");
    expect(out).toContain("Do not stage or commit");
  });

  it("names the right tool to call again after a ship conflict", () => {
    expect(describeShip({ state: "conflicts", base: "master", conflicts: ["plan.md"] })).toContain("call `ship` again");
  });

  it("does not call an empty ship a success", () => {
    expect(describeShip({ state: "nothing", base: "master" })).toContain("Nothing to ship");
  });
});
