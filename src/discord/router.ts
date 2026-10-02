/**
 * The routing decision, as a pure function.
 *
 * Extracted from the client so the whole table can be tested without a gateway
 * connection. The failure modes here are quiet ones — a bot that answers its
 * own posts, or one that hijacks threads it did not open — so each rule is
 * asserted in router.test.ts.
 */

export interface RouteInput {
  readonly authorIsBot: boolean;
  readonly isWebhook: boolean;
  readonly guildId: string | null;
  readonly expectedGuildId: string;
  readonly inThread: boolean;
  /** True when this thread maps to a session we opened. */
  readonly knownSession: boolean;
  /** A literal @mention of the bot, not @everyone / role / reply. */
  readonly mentioned: boolean;
  readonly channelId: string;
  /** For a thread, the channel it hangs off. Used for the allowlist check. */
  readonly parentChannelId?: string | undefined;
  /** Empty means any channel is acceptable. */
  readonly allowedChannels: readonly string[];
  /**
   * A channel message that is a Discord reply to a scheduled brief this bot
   * posted. That is one of the two ways to continue a brief (the other is
   * starting a thread from it), so it needs no mention.
   */
  readonly repliesToBrief?: boolean | undefined;
}

export type RouteDecision =
  | { readonly action: "ignore"; readonly reason: string }
  /** A thread the bot already owns. */
  | { readonly action: "continue" }
  /** A thread someone else opened, joined on an explicit mention. */
  | { readonly action: "adopt" }
  /** A channel message; open a new thread. */
  | { readonly action: "open" }
  /** A channel reply to a brief; continue that brief in its thread. */
  | { readonly action: "brief" };

export function route(i: RouteInput): RouteDecision {
  // Nothing automated may trigger a turn — including this bot's own briefs.
  if (i.authorIsBot) return { action: "ignore", reason: "author is a bot" };
  if (i.isWebhook) return { action: "ignore", reason: "webhook message" };
  if (i.guildId === null) return { action: "ignore", reason: "not in a guild" };
  if (i.guildId !== i.expectedGuildId) return { action: "ignore", reason: "different guild" };

  if (i.inThread) {
    // Inside one of our own threads, every message is a prompt.
    if (i.knownSession) return { action: "continue" };

    // A thread someone else opened. Joining on an explicit mention lets the
    // bot be pulled into a conversation already under way; without one it
    // stays out, so it never speaks unbidden.
    if (!i.mentioned) {
      return { action: "ignore", reason: "thread not opened by this bot, and no mention" };
    }
    if (!channelAllowed(i.parentChannelId ?? i.channelId, i.allowedChannels)) {
      return { action: "ignore", reason: "thread's parent channel is not in the chat allowlist" };
    }
    return { action: "adopt" };
  }

  // Before the mention check: replying to the brief is itself the address. No
  // channel allowlist either — the brief is there because the bot posted it.
  if (i.repliesToBrief) return { action: "brief" };

  if (!i.mentioned) return { action: "ignore", reason: "no direct mention" };
  if (!channelAllowed(i.channelId, i.allowedChannels)) {
    return { action: "ignore", reason: "channel not in the chat allowlist" };
  }
  return { action: "open" };
}

function channelAllowed(channelId: string, allowed: readonly string[]): boolean {
  return allowed.length === 0 || allowed.includes(channelId);
}

/**
 * Why a message carries no usable prompt.
 *
 * These two cases are indistinguishable after the mention is stripped but have
 * opposite causes and opposite remedies, and conflating them cost a real
 * debugging session: a bare ping was answered with "the Message Content intent
 * is probably off", sending the operator to reconfigure Discord for a feature
 * that was plainly working.
 */
export type ContentKind = "prompt" | "bare-mention" | "unreadable";

export function classifyContent(i: {
  /** The message as delivered by the gateway, before stripping. */
  readonly raw: string;
  /** What remains once the bot's own mention is removed. */
  readonly stripped: string;
  readonly hasAttachments: boolean;
}): ContentKind {
  if (i.stripped.trim().length > 0) return "prompt";
  // Text arrived and was entirely a mention: the intent is delivering content.
  if (i.raw.trim().length > 0) return "bare-mention";
  // Attachments arrive regardless of the Message Content intent, so their
  // presence is not evidence either way — but an image with no caption is a
  // deliberate post, not a misconfiguration.
  return i.hasAttachments ? "bare-mention" : "unreadable";
}
