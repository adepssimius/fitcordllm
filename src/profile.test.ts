import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { Profiles, type Profile } from "./profile.js";

const profile = (name: string, channels: string): Profile =>
  ({
    cfg: loadConfig({ DATA_DIR: "/tmp/fitcord-test", DISCORD_CHAT_CHANNEL_IDS: channels } as NodeJS.ProcessEnv),
    // Only the config is consulted here.
    workspaces: undefined as never,
    manager: undefined as never,
  }) as Profile & { cfg: { name: string } } as Profile;

const named = (name: string, channels: string): Profile => {
  const p = profile(name, channels);
  return { ...p, cfg: { ...p.cfg, name } };
};

describe("Profiles", () => {
  it("lets a lone profile with no channel list answer anywhere, as before profiles existed", () => {
    const ps = new Profiles([named("default", "")]);
    expect(ps.forChannel("anything")?.cfg.name).toBe("default");
    expect(ps.channels).toEqual([]);
  });

  it("gives each channel to the profile that lists it", () => {
    const ps = new Profiles([named("ben", "111"), named("amy", "222")]);
    expect(ps.forChannel("111")?.cfg.name).toBe("ben");
    expect(ps.forChannel("222")?.cfg.name).toBe("amy");
    expect(ps.forChannel("333")).toBeUndefined();
    expect(ps.channels).toEqual(["111", "222"]);
  });

  it("gives a profile with no channel nothing, once there is more than one", () => {
    const ps = new Profiles([named("ben", "111"), named("amy", "")]);
    expect(ps.forChannel("999")).toBeUndefined();
  });

  it("hands rows from the pre-profile installation to the first profile", () => {
    const ps = new Profiles([named("ben", "111"), named("amy", "222")]);
    expect(ps.named("default").cfg.name).toBe("ben");
    expect(ps.named("amy").cfg.name).toBe("amy");
  });
});
