import { describe, expect, it } from "vitest";
import { buildMessages, splitBlocks, statusColumn, tableToEmbeds, type Table } from "./tables.js";

/** The readiness table from a real morning brief — the case this exists for. */
const READINESS = `| Signal | Value | Call |
|---|---|---|
| sleep | 6h56 (3h42 + 3h13, two fragments) | AMBER |
| quality | 0.71 / 0.82 per segment | AMBER |
| deep | 1h54 (27% of sleep) | normal |
| HRV | 87ms (90 / 84, 77 samples) | GREEN |
| resources | 0.76 @ 06:30 pre-ride → 0.28 now | GREEN then RED |
| soreness | not reported | |`;

const table = (md: string): Table => {
  const b = splitBlocks(md).find((x) => x.kind === "table");
  if (!b || b.kind !== "table") throw new Error("no table parsed");
  return b.table;
};

describe("splitBlocks", () => {
  it("separates the prose around a table from the table", () => {
    const blocks = splitBlocks(`**1. The data**\n\n${READINESS}\n\nTwo things worth separating.`);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "table", "text"]);
    expect(blocks[2]).toMatchObject({ kind: "text" });
  });

  it("reads header and rows, with or without outer pipes", () => {
    expect(table("a | b\n--- | ---\n1 | 2")).toEqual({ header: ["a", "b"], rows: [["1", "2"]] });
    expect(table("| a | b |\n|:--|--:|\n| 1 | 2 |")).toEqual({ header: ["a", "b"], rows: [["1", "2"]] });
  });

  it("pads a row that dropped its trailing empty cell", () => {
    expect(table(READINESS).rows[5]).toEqual(["soreness", "not reported", ""]);
  });

  it("keeps an escaped pipe inside a cell", () => {
    expect(table("| a | b |\n|---|---|\n| x \\| y | 2 |").rows[0]).toEqual(["x | y", "2"]);
  });

  it("leaves a table inside a code fence alone", () => {
    const blocks = splitBlocks("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["text"]);
  });

  it("does not mistake a horizontal rule or a stray pipe for a table", () => {
    expect(splitBlocks("a | b\n---\nmore").map((b) => b.kind)).toEqual(["text"]);
    expect(splitBlocks("use `grep a | wc -l` here").map((b) => b.kind)).toEqual(["text"]);
  });

  it("ignores a header with no rows under it", () => {
    expect(splitBlocks("| a | b |\n|---|---|\n\nprose").map((b) => b.kind)).toEqual(["text"]);
  });
});

describe("statusColumn", () => {
  it("finds the traffic-light column", () => {
    expect(statusColumn(table(READINESS))).toBe(2);
  });

  it("is never the label column", () => {
    expect(statusColumn(table("| Zone | Pace |\n|---|---|\n| red | 4:10 |\n| green | 6:00 |"))).toBeUndefined();
  });

  it("does not treat prose that mentions a colour as a rating", () => {
    const t = table(
      "| Day | Notes |\n|---|---|\n| Sat | the red loop is closed for the race, so use the green trail instead |\n| Sun | rest |",
    );
    expect(statusColumn(t)).toBeUndefined();
  });
});

describe("tableToEmbeds", () => {
  const [embed] = tableToEmbeds(table(READINESS));

  it("makes one field per row, labelled by the first column", () => {
    expect(embed?.fields.map((f) => f.name)).toEqual([
      "🟡 sleep",
      "🟡 quality",
      "⚪ deep",
      "🟢 HRV",
      "🟢→🔴 resources",
      "⚪ soreness",
    ]);
  });

  it("puts the other columns in the value, without repeating the status word", () => {
    expect(embed?.fields[0]?.value).toBe("6h56 (3h42 + 3h13, two fragments)");
    expect(embed?.fields[4]?.value).toBe("0.76 @ 06:30 pre-ride → 0.28 now");
  });

  it("keeps a status cell that says something other than a colour", () => {
    expect(embed?.fields[2]?.value).toBe("1h54 (27% of sleep) · _normal_");
  });

  it("colours the card by the worst rating in it", () => {
    expect(embed?.color).toBe(0xd83c3e);
    const calm = tableToEmbeds(table("| a | call |\n|---|---|\n| x | GREEN |\n| y | AMBER |"))[0];
    expect(calm?.color).toBe(0xe0a836);
  });

  it("stacks rows when any value is long, so nothing sits in a ragged grid", () => {
    expect(embed?.fields.every((f) => !f.inline)).toBe(true);
  });

  it("sets short values side by side", () => {
    const [e] = tableToEmbeds(table("| Metric | Value |\n|---|---|\n| HRV | 87ms |\n| RHR | 41 |"));
    expect(e?.fields).toEqual([
      { name: "HRV", value: "87ms", inline: true },
      { name: "RHR", value: "41", inline: true },
    ]);
    expect(e?.color).toBeUndefined();
  });

  it("labels each value when a row has several, so the numbers keep their meaning", () => {
    const [e] = tableToEmbeds(
      table("| Day | Session | Duration | Target |\n|---|---|---|---|\n| Sat | lap sim 2 | 3h10 | HR Z1 |"),
    );
    expect(e?.fields[0]).toEqual({
      name: "Sat",
      value: "**Session** lap sim 2\n**Duration** 3h10\n**Target** HR Z1",
      inline: false,
    });
  });

  it("never emits an empty value, which Discord rejects", () => {
    const [e] = tableToEmbeds(table("| a | b |\n|---|---|\n| x |  |"));
    expect(e?.fields[0]?.value).toBe("​");
  });

  it("splits a long table across embeds at Discord's 25-field limit", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| r${i} | v${i} |`).join("\n");
    const embeds = tableToEmbeds(table(`| a | b |\n|---|---|\n${rows}`));
    expect(embeds.map((e) => e.fields.length)).toEqual([25, 5]);
  });

  it("clips a cell that would overflow a field", () => {
    const [e] = tableToEmbeds(table(`| a | b |\n|---|---|\n| x | ${"y".repeat(1500)} |`));
    expect(e?.fields[0]?.value.length).toBe(1024);
    expect(e?.fields[0]?.value.endsWith("…")).toBe(true);
  });
});

describe("buildMessages", () => {
  it("leaves an answer with no table as plain text", () => {
    expect(buildMessages("Easy 45 min today.")).toEqual([{ content: "Easy 45 min today.", embeds: [] }]);
  });

  it("hangs a table under the text that introduces it, and starts a new message after", () => {
    const out = buildMessages(`**1. The data**\n\n${READINESS}\n\nTwo things worth separating.`);
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe("**1. The data**");
    expect(out[0]?.embeds).toHaveLength(1);
    expect(out[1]).toEqual({ content: "Two things worth separating.", embeds: [] });
  });

  it("sends a table that opens the answer as a card with no text", () => {
    const out = buildMessages(`${READINESS}\n\nThat is the whole picture.`);
    expect(out[0]?.content).toBe("");
    expect(out[0]?.embeds).toHaveLength(1);
    expect(out[1]?.content).toBe("That is the whole picture.");
  });

  it("keeps the order when there are two tables", () => {
    const small = "| a | b |\n|---|---|\n| x | 1 |";
    const out = buildMessages(`first\n\n${small}\n\nsecond\n\n${small}\n\nthird`);
    expect(out.map((m) => [m.content, m.embeds.length])).toEqual([
      ["first", 1],
      ["second", 1],
      ["third", 0],
    ]);
  });

  it("never puts more than Discord's embed character budget in one message", () => {
    const rows = Array.from({ length: 24 }, (_, i) => `| row ${i} | ${"v".repeat(400)} |`).join("\n");
    const out = buildMessages(`intro\n\n| a | b |\n|---|---|\n${rows}\n\n| a | b |\n|---|---|\n${rows}`);
    for (const m of out) {
      const chars = m.embeds.reduce((n, e) => n + e.fields.reduce((k, f) => k + f.name.length + f.value.length, 0), 0);
      expect(chars).toBeLessThanOrEqual(6000);
    }
  });

  it("does not turn a fenced table into a card", () => {
    const out = buildMessages("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```");
    expect(out).toHaveLength(1);
    expect(out[0]?.embeds).toEqual([]);
  });
});
