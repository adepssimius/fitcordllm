import { splitForDiscord, SAFE_LIMIT } from "./render.js";

/**
 * Tables, for a client that cannot draw them.
 *
 * Discord renders no markdown tables: the reader sees raw pipes and dashes.
 * The first answer to that was "tell the model not to write tables", and what
 * came back was a table anyway, hand-aligned inside a code fence — monospace,
 * no colour, and broken on a phone the moment a row is wider than the screen.
 * Tabular data does not stop being tabular because the renderer is missing.
 *
 * So the model writes an ordinary markdown table and the bot translates it to
 * the nearest thing Discord has: an embed, one field per row. The first column
 * becomes the field's bold label, the remaining columns its value, and a
 * column of GREEN / AMBER / RED becomes a coloured dot on the label and the
 * accent colour of the whole card. Fields wrap on a narrow screen instead of
 * misaligning, which is the property the code fence could not have.
 *
 * Pure throughout — no client, no I/O — so the shapes are unit tested.
 */

export interface Table {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export type Block =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "table"; readonly table: Table; readonly raw: string };

/** The subset of a Discord embed this module produces. */
export interface TableEmbed {
  color?: number;
  fields: { name: string; value: string; inline: boolean }[];
}

/** One Discord message: text, with any cards shown beneath it. */
export interface OutMessage {
  readonly content: string;
  readonly embeds: readonly TableEmbed[];
}

const FENCE = /^\s*```/;
/** `|---|:--:|` — at least two columns, or it is just a horizontal rule. */
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/** Discord's limits on an embed, with a little room to spare. */
const MAX_FIELDS = 25;
const MAX_NAME = 256;
const MAX_VALUE = 1024;
const MAX_EMBEDS_PER_MESSAGE = 10;
/** The cap is 6000 characters across every embed in one message. */
const MAX_EMBED_CHARS = 5500;
/** Values at or under this sit side by side; longer ones stack. */
const INLINE_VALUE_MAX = 24;

function splitRow(line: string): string[] {
  const cells = line.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  // A leading or trailing pipe produces an empty first or last cell.
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** Splits text into prose and tables, leaving anything inside a code fence alone. */
export function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let prose: string[] = [];
  let inFence = false;

  const flushProse = (): void => {
    if (prose.length === 0) return;
    blocks.push({ kind: "text", text: prose.join("\n") });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (FENCE.test(line)) {
      inFence = !inFence;
      prose.push(line);
      continue;
    }

    const next = lines[i + 1];
    if (!inFence && line.includes("|") && next !== undefined && SEPARATOR.test(next)) {
      const header = splitRow(line);
      if (header.length >= 2 && splitRow(next).length === header.length) {
        const raw = [line, next];
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
          raw.push(lines[j]!);
          const cells = splitRow(lines[j]!);
          // Ragged rows are padded or trimmed rather than rejected: a model
          // that drops a trailing empty cell has still written a table.
          rows.push(header.map((_, c) => cells[c] ?? ""));
          j++;
        }
        if (rows.length > 0) {
          flushProse();
          blocks.push({ kind: "table", table: { header, rows }, raw: raw.join("\n") });
          i = j - 1;
          continue;
        }
      }
    }

    prose.push(line);
  }

  flushProse();
  return blocks;
}

type Level = "green" | "amber" | "red" | "black";

const LEVELS: Record<string, Level> = {
  green: "green",
  amber: "amber",
  yellow: "amber",
  red: "red",
  black: "black",
};
const DOT: Record<Level, string> = { green: "🟢", amber: "🟡", red: "🔴", black: "⚫" };
const SEVERITY: Record<Level, number> = { green: 1, amber: 2, red: 3, black: 4 };
const COLOUR: Record<Level, number> = { green: 0x3ba55c, amber: 0xe0a836, red: 0xd83c3e, black: 0x23272a };
const NEUTRAL_DOT = "⚪";

const STATUS_WORD = /\b(green|amber|yellow|red|black)\b/gi;
/** Words that only join two statuses: "GREEN then RED", "amber -> red". */
const CONNECTIVE = /\b(then|to|and)\b|->|→|[/,·]/gi;

function levelsIn(cell: string): Level[] {
  return [...cell.matchAll(STATUS_WORD)].map((m) => LEVELS[m[1]!.toLowerCase()]!);
}

/** What is left of a status cell once the status words themselves are gone. */
function statusRemainder(cell: string): string {
  return cell.replace(STATUS_WORD, "").replace(CONNECTIVE, "").trim();
}

/**
 * Finds the column that carries a traffic-light rating, if there is one.
 *
 * Never the first column — that is the row's label — and only a column whose
 * cells are short: "the red-eye flight was green-lit" in a notes column is
 * prose that happens to contain colour words, not a status.
 */
export function statusColumn(table: Table): number | undefined {
  for (let c = table.header.length - 1; c >= 1; c--) {
    const cells = table.rows.map((r) => r[c] ?? "");
    const rated = cells.filter((cell) => levelsIn(cell).length > 0).length;
    if (rated === 0) continue;
    if (cells.every((cell) => cell.length <= 28) && rated * 2 >= cells.filter((x) => x !== "").length) return c;
  }
  return undefined;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Turns a table into one or more embeds, one field per row. */
export function tableToEmbeds(table: Table): TableEmbed[] {
  const statusCol = statusColumn(table);
  const valueCols = table.header.map((_, c) => c).filter((c) => c !== 0 && c !== statusCol);

  let worst: Level | undefined;

  const fields = table.rows.map((row) => {
    let label = row[0] ?? "";
    const parts: string[] = [];

    for (const c of valueCols) {
      const cell = row[c] ?? "";
      if (cell === "") continue;
      // With one value column the header adds nothing; with several, a bare
      // "45 min · Z1" has lost which number was which.
      parts.push(valueCols.length > 1 ? `**${table.header[c]}** ${cell}` : cell);
    }

    if (statusCol !== undefined) {
      const cell = row[statusCol] ?? "";
      const levels = levelsIn(cell);
      for (const l of levels) if (!worst || SEVERITY[l] > SEVERITY[worst]) worst = l;
      label = `${levels.length > 0 ? levels.map((l) => DOT[l]).join("→") : NEUTRAL_DOT} ${label}`;
      // "normal", "not scored": a status cell that says something other than a
      // colour still carries information, so it joins the value.
      const rest = levels.length > 0 ? statusRemainder(cell) : cell;
      if (rest !== "") parts.push(`_${rest}_`);
    }

    const stacked = valueCols.length > 1;
    return {
      name: clip(label.trim() || "​", MAX_NAME),
      // Discord rejects an empty field value; a zero-width space is the
      // conventional stand-in.
      value: clip(parts.join(stacked ? "\n" : " · ") || "​", MAX_VALUE),
    };
  });

  // Side by side only when every value is short. One long value in a grid of
  // short ones makes ragged rows that read worse than a plain stack.
  const inline = fields.every((f) => f.value.length <= INLINE_VALUE_MAX && !f.value.includes("\n"));

  // Two limits apply to an embed and either can come first: 25 fields, and a
  // character budget that a table of long cells reaches well before that.
  const embeds: TableEmbed[] = [];
  let current: TableEmbed["fields"] = [];
  let chars = 0;
  const close = (): void => {
    if (current.length === 0) return;
    embeds.push({ ...(worst ? { color: COLOUR[worst] } : {}), fields: current });
    current = [];
    chars = 0;
  };
  for (const f of fields) {
    const size = f.name.length + f.value.length;
    if (current.length >= MAX_FIELDS || chars + size > MAX_EMBED_CHARS) close();
    current.push({ ...f, inline });
    chars += size;
  }
  close();
  return embeds;
}

function embedChars(e: TableEmbed): number {
  return e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

/**
 * Lays an answer out as Discord messages.
 *
 * A message is text with its embeds beneath it, never the other way round. So
 * a table is attached to the message holding the prose that introduces it, and
 * whatever follows the table starts a new message — which keeps the order the
 * model wrote: lead-in, table, discussion.
 */
export function buildMessages(text: string, limit = SAFE_LIMIT): OutMessage[] {
  const out: { content: string; embeds: TableEmbed[] }[] = [];
  /** True while the last message may still take a table directly under its text. */
  let open = false;

  for (const block of splitBlocks(text)) {
    if (block.kind === "text") {
      if (block.text.trim() === "") continue;
      for (const chunk of splitForDiscord(block.text.trim(), limit)) out.push({ content: chunk, embeds: [] });
      open = true;
      continue;
    }

    for (const embed of tableToEmbeds(block.table)) {
      const last = out[out.length - 1];
      const fits =
        last !== undefined &&
        (open || last.embeds.length > 0) &&
        last.embeds.length < MAX_EMBEDS_PER_MESSAGE &&
        last.embeds.reduce((n, e) => n + embedChars(e), 0) + embedChars(embed) <= MAX_EMBED_CHARS;
      if (fits) last.embeds.push(embed);
      else out.push({ content: "", embeds: [embed] });
    }
    // Prose after a table belongs under it, in a message of its own.
    open = false;
  }

  return out;
}
