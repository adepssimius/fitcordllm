import { describe, expect, it } from "vitest";
import { DISCORD_MAX, formatToolCall, renderProgress, splitForDiscord } from "./render.js";

const fenceCount = (s: string): number => (s.match(/```/g) ?? []).length;

describe("splitForDiscord", () => {
  it("leaves a short message alone", () => {
    expect(splitForDiscord("hello")).toEqual(["hello"]);
  });

  it("drops an empty message rather than posting whitespace", () => {
    expect(splitForDiscord("")).toEqual([]);
  });

  it("keeps every chunk within Discord's hard cap", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} of some output`).join("\n");
    for (const c of splitForDiscord(text)) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX);
    }
  });

  it("loses no content when splitting", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const rejoined = splitForDiscord(text).join("\n").replace(/```\w*\n?/g, "");
    for (const probe of ["line 0", "line 150", "line 299"]) {
      expect(rejoined).toContain(probe);
    }
  });

  it("closes and reopens a code fence that straddles a boundary", () => {
    const body = Array.from({ length: 300 }, (_, i) => `osd.${i} up in`).join("\n");
    const text = `here is the tree\n\`\`\`text\n${body}\n\`\`\``;
    const chunks = splitForDiscord(text);

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must have balanced fences, or Discord renders it as prose.
    for (const c of chunks) {
      expect(fenceCount(c) % 2).toBe(0);
    }
    // The continuation reopens with the original language tag.
    expect(chunks[1]).toMatch(/^```text/);
  });

  it("hard-splits a single line longer than the limit", () => {
    const chunks = splitForDiscord("x".repeat(5000));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MAX);
  });
});

describe("formatToolCall", () => {
  it("strips the mcp prefix and renders arguments compactly", () => {
    expect(
      formatToolCall("mcp__suuntool__workouts_list", { limit: 5, fields: ["id", "start"] }),
    ).toBe("suuntool__workouts_list limit=5 fields=id start");
  });

  it("omits absent and false-valued arguments", () => {
    expect(formatToolCall("mcp__fitcord__ship", { message: "log 10-02", draft: undefined, force: false })).toBe(
      "ship message=log 10-02",
    );
  });

  it("truncates rather than overflowing the activity block", () => {
    const out = formatToolCall("Bash", { command: "x".repeat(300) });
    expect(out.length).toBeLessThanOrEqual(96);
    expect(out.endsWith("…")).toBe(true);
  });

  it("survives a non-object input", () => {
    expect(() => formatToolCall("t", "not-an-object")).not.toThrow();
  });
});

describe("renderProgress", () => {
  it("shows a placeholder before any text arrives", () => {
    expect(renderProgress({ text: "", tools: [], done: false })).toBe("_working…_");
  });

  it("appends a rolling window of recent tool calls while running", () => {
    const tools = Array.from({ length: 12 }, (_, i) => `call ${i}`);
    const out = renderProgress({ text: "thinking about it", tools, done: false });
    expect(out).toContain("call 11");
    expect(out).not.toContain("call 0"); // rolled off
    expect(out).toContain("_working…_");
  });

  it("drops the activity block and spinner once finished", () => {
    const out = renderProgress({ text: "final answer", tools: ["call 1"], done: true });
    expect(out).toBe("final answer");
  });

  it("trims the head so the newest output stays visible, and stays in budget", () => {
    const out = renderProgress({ text: `${"A".repeat(3000)}TAIL`, tools: [], done: true, limit: 500 });
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out.startsWith("…")).toBe(true);
  });
});
