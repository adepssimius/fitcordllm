import { describe, expect, it } from "vitest";
import { classifyContent, route, type RouteInput } from "./router.js";

const base: RouteInput = {
  authorIsBot: false,
  isWebhook: false,
  guildId: "g1",
  expectedGuildId: "g1",
  inThread: false,
  knownSession: false,
  mentioned: false,
  channelId: "c1",
  allowedChannels: [],
};

const at = (over: Partial<RouteInput>) => route({ ...base, ...over });

describe("self-trigger protection", () => {
  // The bot posts scheduled briefs into the same guild. If it answered its own
  // messages it would loop against the operator's subscription quota.
  it("ignores its own and other bots' messages even when mentioned", () => {
    expect(at({ authorIsBot: true, mentioned: true }).action).toBe("ignore");
  });

  it("ignores webhook posts even inside one of our threads", () => {
    const d = at({ isWebhook: true, inThread: true, knownSession: true });
    expect(d.action).toBe("ignore");
    if (d.action === "ignore") expect(d.reason).toBe("webhook message");
  });
});

describe("guild scoping", () => {
  it("ignores messages from another guild", () => {
    expect(at({ guildId: "other", mentioned: true }).action).toBe("ignore");
  });

  it("ignores DMs, which have no guild", () => {
    expect(at({ guildId: null, mentioned: true }).action).toBe("ignore");
  });
});

describe("threads", () => {
  it("treats every message in one of our threads as a prompt, mention or not", () => {
    expect(at({ inThread: true, knownSession: true, mentioned: false }).action).toBe("continue");
  });

  it("adopts a thread someone else opened when explicitly mentioned", () => {
    // The case this exists for: a human opens a thread on some other post
    // and asks the bot about it. That is the most natural place to ask, and
    // refusing there made the bot look broken with no trace in the log.
    expect(at({ inThread: true, knownSession: false, mentioned: true }).action).toBe("adopt");
  });

  it("stays out of a thread it did not open when not mentioned", () => {
    // Still never speaks unbidden — an unrelated thread is not its business.
    const d = at({ inThread: true, knownSession: false, mentioned: false });
    expect(d.action).toBe("ignore");
    if (d.action === "ignore") expect(d.reason).toContain("no mention");
  });

  it("honours the channel allowlist via the thread's parent", () => {
    // A thread's own id is not in the allowlist; the parent channel is.
    const allowed = at({
      inThread: true, knownSession: false, mentioned: true,
      channelId: "thread-99", parentChannelId: "c1", allowedChannels: ["c1"],
    });
    expect(allowed.action).toBe("adopt");

    const refused = at({
      inThread: true, knownSession: false, mentioned: true,
      channelId: "thread-99", parentChannelId: "c9", allowedChannels: ["c1"],
    });
    expect(refused.action).toBe("ignore");
  });

  it("still refuses a webhook post inside an adoptable thread", () => {
    // A webhook must never trigger a turn, mention or not.
    expect(at({ inThread: true, knownSession: false, mentioned: true, isWebhook: true }).action).toBe("ignore");
  });
});

describe("mentions in channels", () => {
  it("opens a thread on a direct mention", () => {
    expect(at({ mentioned: true }).action).toBe("open");
  });

  it("ignores a channel message with no mention", () => {
    expect(at({ mentioned: false }).action).toBe("ignore");
  });

  it("honours the channel allowlist", () => {
    expect(at({ mentioned: true, allowedChannels: ["c1"] }).action).toBe("open");
    const d = at({ mentioned: true, channelId: "c9", allowedChannels: ["c1"] });
    expect(d.action).toBe("ignore");
    if (d.action === "ignore") expect(d.reason).toContain("allowlist");
  });

  it("permits any channel when the allowlist is empty", () => {
    expect(at({ mentioned: true, channelId: "anything", allowedChannels: [] }).action).toBe("open");
  });
});

describe("content classification", () => {
  const c = (over: Partial<Parameters<typeof classifyContent>[0]>) =>
    classifyContent({ raw: "", stripped: "", hasAttachments: false, ...over });

  it("treats a message with text after the mention as a prompt", () => {
    expect(c({ raw: "<@1> what is broken?", stripped: "what is broken?" })).toBe("prompt");
  });

  it("calls a mention with nothing else a bare mention, not a broken intent", () => {
    // The regression this exists for: a bare ping was answered with "the
    // Message Content intent is probably off", which is plainly false — the
    // mention itself arrived as content. The operator then went and checked
    // Discord instead of just typing a question.
    expect(c({ raw: "<@1536239175853023333>", stripped: "" })).toBe("bare-mention");
  });

  it("reports unreadable only when nothing at all arrived", () => {
    expect(c({ raw: "", stripped: "" })).toBe("unreadable");
    expect(c({ raw: "   ", stripped: "" })).toBe("unreadable");
  });

  it("does not blame the intent for an uncaptioned attachment", () => {
    // Attachments arrive whether or not the intent is on, so their presence is
    // no evidence of a misconfiguration.
    expect(c({ raw: "", stripped: "", hasAttachments: true })).toBe("bare-mention");
  });
});

describe("continuing a scheduled brief", () => {
  it("treats a channel reply to a brief as addressed, with no mention", () => {
    expect(at({ repliesToBrief: true }).action).toBe("brief");
  });

  it("does not require the brief's channel to be in the chat allowlist", () => {
    // The brief is in that channel because the bot posted it there.
    expect(at({ repliesToBrief: true, channelId: "briefs", allowedChannels: ["chat"] }).action).toBe("brief");
  });

  it("still ignores a bot replying to a brief", () => {
    expect(at({ repliesToBrief: true, authorIsBot: true }).action).toBe("ignore");
  });

  it("continues a thread started from a brief like any thread it owns", () => {
    // By the time route() runs, the thread has been bound to the brief's
    // session, so it is simply a known thread.
    expect(at({ inThread: true, knownSession: true }).action).toBe("continue");
  });
});
