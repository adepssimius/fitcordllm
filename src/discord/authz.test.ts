import { describe, expect, it } from "vitest";
import { authorisesSomeone, checkActor } from "./authz.js";

const me = { userId: "u1", roleIds: ["r1"] };

describe("checkActor", () => {
  it("trusts the channel when the profile is confined to one", () => {
    // A private channel is the gate; whoever can post there is in.
    expect(checkActor({ userIds: [], roleIds: [], channelGated: true }, me).allowed).toBe(true);
  });

  it("narrows a channel further when an allowlist is given as well", () => {
    const cfg = { userIds: ["u2"], roleIds: [], channelGated: true };
    expect(checkActor(cfg, me).allowed).toBe(false);
    expect(checkActor(cfg, { userId: "u2", roleIds: [] }).allowed).toBe(true);
  });

  it("requires an allowlist when the profile answers in any channel", () => {
    const d = checkActor({ userIds: [], roleIds: [], channelGated: false }, me);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain("DISCORD_CHAT_CHANNEL_IDS");
  });

  it("accepts a user id or a role id from the allowlist", () => {
    expect(checkActor({ userIds: ["u1"], roleIds: [], channelGated: false }, me).allowed).toBe(true);
    expect(checkActor({ userIds: [], roleIds: ["r1"], channelGated: false }, me).allowed).toBe(true);
    expect(checkActor({ userIds: ["u9"], roleIds: ["r9"], channelGated: false }, me).allowed).toBe(false);
  });
});

describe("authorisesSomeone", () => {
  it("is false only when there is neither a channel nor an allowlist", () => {
    expect(authorisesSomeone({ userIds: [], roleIds: [], channelGated: false })).toBe(false);
    expect(authorisesSomeone({ userIds: [], roleIds: [], channelGated: true })).toBe(true);
    expect(authorisesSomeone({ userIds: ["u1"], roleIds: [], channelGated: false })).toBe(true);
  });
});
