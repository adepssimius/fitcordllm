import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadProfiles, profileEnvPrefix } from "./config.js";

const env = (o: Record<string, string>): NodeJS.ProcessEnv => ({ DATA_DIR: "/tmp/fitcord-test", ...o });

describe("profiles", () => {
  it("is one profile called default, read from the plain variables, when none are named", () => {
    const [p, ...rest] = loadProfiles(env({ GIT_REPO: "me/training", DISCORD_CHAT_USER_IDS: "1" }));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      name: "default",
      GIT_REPO: "me/training",
      remoteUrl: "https://github.com/me/training.git",
      DISCORD_CHAT_USER_IDS: ["1"],
    });
  });

  it("reads each named profile's own variables, falling back to the plain ones", () => {
    const profiles = loadProfiles(
      env({
        FITCORD_PROFILES: "ben,amy",
        BOT_TIMEZONE: "America/New_York",
        GIT_REPO: "ben/git-fit",
        LIFTOSAUR_API_KEY: "ben-lifts",
        PROFILE_AMY_GIT_REPO: "amy/git-fit",
        PROFILE_AMY_LIFTOSAUR_API_KEY: "",
        PROFILE_AMY_DISCORD_CHAT_CHANNEL_IDS: "222",
        PROFILE_BEN_DISCORD_CHAT_CHANNEL_IDS: "111",
      }),
    );
    expect(profiles.map((p) => p.name)).toEqual(["ben", "amy"]);
    const [ben, amy] = profiles;
    expect(ben).toMatchObject({ GIT_REPO: "ben/git-fit", LIFTOSAUR_API_KEY: "ben-lifts", DISCORD_CHAT_CHANNEL_IDS: ["111"] });
    // Shared defaults reach every profile.
    expect(amy?.BOT_TIMEZONE).toBe("America/New_York");
    expect(amy?.GIT_REPO).toBe("amy/git-fit");
    expect(amy?.DISCORD_CHAT_CHANNEL_IDS).toEqual(["222"]);
  });

  it("treats an empty per-profile value as unset, so it falls back rather than blanking", () => {
    // A ConfigMap key left as "" means "not set for her", not "set to nothing".
    const [amy] = loadProfiles(
      env({ FITCORD_PROFILES: "amy", LIFTOSAUR_API_KEY: "shared", PROFILE_AMY_LIFTOSAUR_API_KEY: "" }),
    );
    expect(amy?.LIFTOSAUR_API_KEY).toBe("shared");
  });

  it("maps a profile name onto an environment prefix", () => {
    expect(profileEnvPrefix("amy")).toBe("PROFILE_AMY_");
    expect(profileEnvPrefix("the-kid")).toBe("PROFILE_THE_KID_");
  });

  it("rejects a profile name that would not survive the trip through an env var", () => {
    expect(() => loadProfiles(env({ FITCORD_PROFILES: "Ben" }))).toThrow(ConfigError);
    expect(() => loadProfiles(env({ FITCORD_PROFILES: "ben,ben" }))).toThrow(/twice/);
  });

  it("checks each profile's time zone", () => {
    expect(() => loadProfiles(env({ FITCORD_PROFILES: "x", PROFILE_X_BOT_TIMEZONE: "Mars/Olympus" }))).toThrow(
      /profile 'x'/,
    );
  });

  it("merges the shared settings with the first profile for single-profile callers", () => {
    const cfg = loadConfig(env({ GIT_REMOTE_URL: "/srv/repo.git", AGENT_MAX_TURNS: "7" }));
    expect(cfg.name).toBe("default");
    expect(cfg.remoteUrl).toBe("/srv/repo.git");
    expect(cfg.AGENT_MAX_TURNS).toBe(7);
  });
});
