/**
 * Who may cause an agent turn.
 *
 * Two ways to be allowed, and a profile needs at least one of them:
 *
 *  - **The channel itself.** A profile confined to a private channel is gated
 *    by Discord: whoever can post there was let in by the server's own
 *    permissions, and the bot does not second-guess that. This is the normal
 *    setup — one private channel per person.
 *  - **An explicit allowlist** of user or role ids. Required when the profile
 *    answers in any channel (no channel list), because then the channel says
 *    nothing about who is asking. Optional on top of a channel, to narrow it.
 *
 * It fails closed: a profile with neither is one anyone on the server could
 * use to spend the operator's Claude subscription, and startup refuses it.
 */

export interface ActorIdentity {
  readonly userId: string;
  readonly roleIds: readonly string[];
}

export interface AuthzConfig {
  readonly userIds: readonly string[];
  readonly roleIds: readonly string[];
  /** True when the profile is confined to its own channel(s). */
  readonly channelGated: boolean;
}

export type AuthzResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Whether a profile's configuration authorises anyone at all. */
export function authorisesSomeone(cfg: AuthzConfig): boolean {
  return cfg.channelGated || cfg.userIds.length > 0 || cfg.roleIds.length > 0;
}

export function checkActor(cfg: AuthzConfig, actor: ActorIdentity): AuthzResult {
  const listed = cfg.userIds.length > 0 || cfg.roleIds.length > 0;
  if (!listed) {
    return cfg.channelGated
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            "no channel and no allowlist — set DISCORD_CHAT_CHANNEL_IDS, or DISCORD_CHAT_ROLE_IDS / DISCORD_CHAT_USER_IDS",
        };
  }
  if (cfg.userIds.includes(actor.userId)) return { allowed: true };
  if (actor.roleIds.some((r) => cfg.roleIds.includes(r))) return { allowed: true };
  return { allowed: false, reason: "not on this profile's allowlist" };
}
