/**
 * Pure text shaping for Discord. No client, no I/O — all of it unit tested.
 *
 * Discord hard-caps a message at 2000 characters. Naive slicing splits code
 * fences in half, which renders the tail of a command output as prose and the
 * rest as an unterminated block, so splitting has to be fence-aware.
 */

export const DISCORD_MAX = 2000;
/** Leave room for a continuation marker and a reopened fence. */
export const SAFE_LIMIT = 1900;

const FENCE = /^```(\w*)\s*$/;

interface FenceState {
  open: boolean;
  lang: string;
}

function applyFence(line: string, state: FenceState): void {
  const m = FENCE.exec(line.trim());
  if (!m) return;
  if (state.open) {
    state.open = false;
    state.lang = "";
  } else {
    state.open = true;
    state.lang = m[1] ?? "";
  }
}

/**
 * Splits text into Discord-sized chunks, closing and reopening any code fence
 * that straddles a boundary so each chunk renders correctly on its own.
 */
export function splitForDiscord(text: string, limit = SAFE_LIMIT): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : [];

  const chunks: string[] = [];
  const state: FenceState = { open: false, lang: "" };
  let current = "";
  let currentOpenedWith = "";

  const flush = (): void => {
    if (current.length === 0) return;
    let out = current;
    if (state.open) out += "\n```"; // close the straddling fence
    chunks.push(out);
    current = "";
    currentOpenedWith = state.open ? `\`\`\`${state.lang}` : "";
  };

  for (const rawLine of text.split("\n")) {
    // A single line longer than the limit has to be hard-split.
    const pieces = rawLine.length > limit ? hardSplit(rawLine, limit - 8) : [rawLine];

    for (const line of pieces) {
      const prefix = current.length === 0 ? currentOpenedWith : "";
      const candidate =
        (current.length === 0 ? prefix : current) + (current.length === 0 && !prefix ? "" : "\n") + line;

      if (candidate.length > limit && current.length > 0) {
        flush();
        current = currentOpenedWith ? `${currentOpenedWith}\n${line}` : line;
      } else {
        current = current.length === 0 ? (prefix ? `${prefix}\n${line}` : line) : `${current}\n${line}`;
      }
      applyFence(line, state);
    }
  }

  if (current.length > 0) {
    chunks.push(state.open ? `${current}\n\`\`\`` : current);
  }
  return chunks;
}

function hardSplit(line: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
  return out;
}

/** Compact one-line summary of a tool call for the live activity block. */
export function formatToolCall(name: string, input: unknown, width = 96): string {
  const short = name.replace(/^mcp__/, "").replace(/^fitcord__/, "");
  let args = "";
  try {
    const o = input as Record<string, unknown> | null;
    if (o && typeof o === "object") {
      args = Object.entries(o)
        .filter(([, v]) => v !== undefined && v !== null && v !== false)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(" ") : String(v)}`)
        .join(" ");
    }
  } catch {
    args = "";
  }
  const line = args ? `${short} ${args}` : short;
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

/**
 * The live in-progress message: streamed text plus a rolling window of recent
 * tool calls. Kept under the limit by trimming the *head* of the text, since
 * the most recent output is what the reader cares about while it is running.
 */
export function renderProgress(opts: {
  text: string;
  tools: readonly string[];
  done: boolean;
  limit?: number;
}): string {
  const limit = opts.limit ?? SAFE_LIMIT;
  const activity =
    opts.tools.length > 0 && !opts.done
      ? `\n\`\`\`\n${opts.tools.slice(-6).join("\n")}\n\`\`\``
      : "";
  const spinner = opts.done ? "" : "\n_working…_";
  const budget = limit - activity.length - spinner.length;

  let body = opts.text;
  if (body.length > budget) {
    body = `…${body.slice(body.length - budget + 1)}`;
  }
  const out = `${body}${activity}${spinner}`.trim();
  return out.length === 0 ? "_working…_" : out;
}
