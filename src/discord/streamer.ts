import { AttachmentBuilder, type Message, type MessageCreateOptions } from "discord.js";
import { formatToolCall, renderProgress, splitForDiscord, SAFE_LIMIT } from "./render.js";

/**
 * Edit-in-place progress for a long agent run.
 *
 * A turn can take minutes and dozens of tool calls. Posting each update as a
 * new message would be unreadable and would burn Discord's rate limit, so one
 * message is edited on a trailing-edge throttle and the final answer replaces
 * it.
 *
 * The target is anything that can be sent to — a thread for a conversation, a
 * channel for a scheduled brief.
 */

/** Just enough of a discord.js channel, so a thread and a text channel both fit. */
export interface Sendable {
  send(options: string | MessageCreateOptions): Promise<Message>;
}

export interface Delivered {
  /** The message the answer starts in. */
  readonly firstId: string | undefined;
  /** Every message the answer occupies, in order. */
  readonly ids: readonly string[];
}

export interface StreamerOptions {
  readonly intervalMs: number;
  readonly maxMessages: number;
  /** Answers longer than this are posted as a file rather than split. */
  readonly attachOver?: number;
}

export class ThreadStreamer {
  private text = "";
  private readonly tools: string[] = [];
  private live: Message | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private flushing = false;
  private posted = 0;
  private closed = false;

  /**
   * `live` seeds the message to edit. A scheduled brief posts its placeholder
   * first — that message's id is what the session is keyed on — and the
   * answer then replaces it in place.
   */
  constructor(
    private readonly thread: Sendable,
    private readonly opts: StreamerOptions,
    live?: Message,
  ) {
    this.live = live;
    if (live) this.posted = 1;
  }

  onText(chunk: string): void {
    this.text += chunk;
    this.schedule();
  }

  onToolUse(name: string, input: unknown): void {
    this.tools.push(formatToolCall(name, input));
    this.schedule();
  }

  /** A short status line that replaces the body until real text arrives. */
  async note(text: string): Promise<void> {
    if (this.posted >= this.opts.maxMessages) return;
    this.posted += 1;
    await this.thread.send(text).catch(() => undefined);
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.opts.intervalMs);
    this.timer.unref?.();
    this.dirty = true;
  }

  private async flush(): Promise<void> {
    if (this.closed || this.flushing || !this.dirty) return;
    this.flushing = true;
    this.dirty = false;
    const body = renderProgress({ text: this.text, tools: this.tools, done: false });

    try {
      if (!this.live) {
        if (this.posted >= this.opts.maxMessages) return;
        this.posted += 1;
        this.live = await this.thread.send(body);
      } else {
        await this.live.edit(body);
      }
    } catch {
      // A failed progress edit is cosmetic; the final answer still lands.
      this.live = undefined;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Replaces the live message with the finished answer. Long answers are split
   * fence-aware, and very long ones are attached as a file rather than smeared
   * across many messages.
   */
  async finish(finalText: string): Promise<Delivered> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Let an in-flight edit settle so it cannot land after the final answer.
    while (this.flushing) await new Promise((r) => setTimeout(r, 20));

    const text = finalText.trim().length > 0 ? finalText : "_(no output)_";
    const attachOver = this.opts.attachOver ?? SAFE_LIMIT * 3;

    if (text.length > attachOver) {
      const summary = `${text.slice(0, 600)}\n\n_…full answer attached._`;
      const file = new AttachmentBuilder(Buffer.from(text, "utf8"), { name: "answer.md" });
      const msg = this.live
        ? await this.live.edit({ content: summary, files: [file] }).catch(() => undefined)
        : await this.thread.send({ content: summary, files: [file] }).catch(() => undefined);
      return { firstId: msg?.id, ids: msg ? [msg.id] : [] };
    }

    const chunks = splitForDiscord(text);
    const first = chunks[0] ?? text;
    let firstMsg: Message | undefined;

    try {
      firstMsg = this.live ? await this.live.edit(first) : await this.thread.send(first);
    } catch {
      firstMsg = await this.thread.send(first).catch(() => undefined);
    }
    const ids: string[] = firstMsg ? [firstMsg.id] : [];

    for (const rest of chunks.slice(1)) {
      if (this.posted >= this.opts.maxMessages) {
        await this.thread.send("_output truncated — message cap reached._").catch(() => undefined);
        break;
      }
      this.posted += 1;
      const more = await this.thread.send(rest).catch(() => undefined);
      if (more) ids.push(more.id);
    }

    return { firstId: firstMsg?.id, ids };
  }
}
