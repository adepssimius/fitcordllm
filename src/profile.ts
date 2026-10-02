import type { Config } from "./config.js";
import type { Workspaces } from "./git/workspaces.js";
import type { SessionManager } from "./session/manager.js";

/**
 * One person's setup, assembled: their settings, their clones, their session
 * manager. The bot holds one of these per profile and picks the right one from
 * the channel a message arrived in, or from the profile stamped on a session.
 */
export interface Profile {
  readonly cfg: Config;
  readonly workspaces: Workspaces;
  readonly manager: SessionManager;
}

export class Profiles {
  constructor(private readonly list: readonly Profile[]) {
    if (list.length === 0) throw new Error("at least one profile is required");
  }

  get all(): readonly Profile[] {
    return this.list;
  }

  get first(): Profile {
    return this.list[0]!;
  }

  /**
   * The profile a stored row names. A row from before profiles existed says
   * `default`; if no profile is called that any more, the first one takes it —
   * which is the single-person installation being renamed, not a conflict.
   */
  named(name: string): Profile {
    return this.list.find((p) => p.cfg.name === name) ?? this.first;
  }

  /**
   * The profile that owns a channel. With one profile and no channel list,
   * every channel is its own — the behaviour before profiles existed. With
   * several profiles, a channel belongs to whichever lists it, and a profile
   * listing no channel owns none.
   */
  forChannel(channelId: string): Profile | undefined {
    if (this.list.length === 1 && this.first.cfg.DISCORD_CHAT_CHANNEL_IDS.length === 0) return this.first;
    return this.list.find((p) => p.cfg.DISCORD_CHAT_CHANNEL_IDS.includes(channelId));
  }

  /** Every channel any profile answers in; empty means any channel (single profile, no list). */
  get channels(): readonly string[] {
    if (this.list.length === 1 && this.first.cfg.DISCORD_CHAT_CHANNEL_IDS.length === 0) return [];
    return this.list.flatMap((p) => p.cfg.DISCORD_CHAT_CHANNEL_IDS);
  }
}
