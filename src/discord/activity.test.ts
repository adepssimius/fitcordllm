import { describe, expect, it } from "vitest";
import { Activity, describeToolCall, displayPath } from "./activity.js";

const root = "/data/threads/3134e30a-6dac-4d26-9e57-ca6d34ccd5e2";

describe("describeToolCall", () => {
  it("uses the description Claude Code asks for on every Bash call, not the command", () => {
    const line = describeToolCall("Bash", {
      command: `cd ${root} && python3 scripts/verify_plan.py | tail -3`,
      description: "Check the plan still passes its invariants",
    });
    expect(line).toBe("Check the plan still passes its invariants");
    expect(line).not.toContain("python3");
  });

  it("never shows the raw command, even when the description is missing", () => {
    expect(describeToolCall("Bash", { command: "rm -rf /tmp/x && ls" })).toBe("Running a command");
  });

  it("phrases file tools around the file, as a repository path", () => {
    expect(describeToolCall("Read", { file_path: `${root}/log/2026-10-04.md` }, root)).toBe("Reading `log/2026-10-04.md`");
    expect(describeToolCall("Edit", { file_path: `${root}/.claude/skills/daily-brief/SKILL.md` }, root)).toBe(
      "Editing `.claude/skills/daily-brief/SKILL.md`",
    );
    expect(describeToolCall("Write", { file_path: "endurance/2026-10-11-long.md" }, root)).toBe(
      "Writing `endurance/2026-10-11-long.md`",
    );
  });

  it("shows only the file name for a scratch file outside the clone", () => {
    expect(describeToolCall("Write", { file_path: "/tmp/workout.json" }, root)).toBe("Writing `workout.json`");
  });

  it("shows the step being worked on from the todo list", () => {
    const line = describeToolCall("TodoWrite", {
      todos: [
        { content: "Pull sleep data", activeForm: "Pulling sleep data", status: "completed" },
        { content: "Score readiness", activeForm: "Scoring readiness against the ladder", status: "in_progress" },
        { content: "Write the log", activeForm: "Writing the log", status: "pending" },
      ],
    });
    expect(line).toBe("Scoring readiness against the ladder");
  });

  it("phrases the account tools in plain words", () => {
    expect(describeToolCall("mcp__suuntool__wellness_sleep", { date: "2026-10-04" })).toBe(
      "Pulling last night's sleep from Suunto",
    );
    expect(describeToolCall("mcp__suuntool__guides_upload", { zip: "UEsDB…" })).toBe("Loading a guide onto the watch");
    expect(describeToolCall("mcp__liftosaur__get_program", {})).toBe("Reading the Liftosaur program");
  });

  it("falls back to the service and the tool's name in words for anything unlisted", () => {
    expect(describeToolCall("mcp__suuntool__profile_settings", {})).toBe("Suunto: profile settings");
    expect(describeToolCall("mcp__liftosaur__list_gyms", {})).toBe("Liftosaur: list gyms");
  });

  it("phrases the bot's own tools", () => {
    expect(describeToolCall("mcp__fitcord__ship", { message: "log 10-04" })).toBe("Shipping this thread's changes");
    expect(describeToolCall("mcp__fitcord__poll", { key: "rpe" })).toBe("Preparing a poll");
  });

  it("names the skill being used", () => {
    expect(describeToolCall("Skill", { skill: "daily-brief" })).toBe("Using the daily-brief skill");
  });

  it("keeps a line to one short row however long the input", () => {
    const line = describeToolCall("Bash", { command: "x", description: "word ".repeat(80) });
    expect(line.length).toBeLessThanOrEqual(90);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("\n");
  });

  it("survives input that is not an object", () => {
    expect(() => describeToolCall("Read", "not-an-object")).not.toThrow();
    expect(describeToolCall("Read", null)).toBe("Reading a file");
  });
});

describe("displayPath", () => {
  it("does not mistake a sibling directory that shares the clone's prefix for the clone", () => {
    expect(displayPath(`${root}-other/log/x.md`, root)).toBe("x.md");
  });
});

describe("Activity", () => {
  it("lists lines oldest first and keeps only the most recent", () => {
    const a = new Activity();
    for (let i = 0; i < 8; i++) a.add(`t${i}`, `step ${i}`);
    expect(a.recent(3)).toEqual(["step 5", "step 6", "step 7"]);
  });

  it("collapses a repeat into one line", () => {
    const a = new Activity();
    a.add("t1", "Reading `AGENTS.md`");
    a.add("t2", "Reading `AGENTS.md`");
    expect(a.recent(5)).toEqual(["Reading `AGENTS.md`"]);
  });

  it("folds the lines a summary covers into the summary, where they stood", () => {
    const a = new Activity();
    a.add("t1", "Reading `AGENTS.md`");
    a.add("t2", "Reading `scripts/verify_plan.py`");
    a.add("t3", "Check the plan still passes");
    a.summarise("Read AGENTS.md & verify_plan.py", ["t1", "t2"]);
    expect(a.recent(5)).toEqual(["Read AGENTS.md & verify_plan.py", "Check the plan still passes"]);
  });

  it("folds a collapsed repeat as soon as any of its calls is summarised", () => {
    const a = new Activity();
    a.add("t1", "Reading a file");
    a.add("t2", "Reading a file");
    a.summarise("Read the plan files", ["t2"]);
    expect(a.recent(5)).toEqual(["Read the plan files"]);
  });

  it("ignores a summary of calls it never saw", () => {
    const a = new Activity();
    a.add("t1", "Reading `AGENTS.md`");
    a.summarise("Something else", ["zz"]);
    expect(a.recent(5)).toEqual(["Reading `AGENTS.md`"]);
  });
});
