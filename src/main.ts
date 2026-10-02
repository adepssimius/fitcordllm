import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ConfigError,
  configFor,
  credentialSource,
  loadCore,
  loadProfiles,
  requireDiscord,
  type Config,
} from "./config.js";
import { createLogger } from "./logger.js";
import { openStore } from "./store/index.js";
import { QuotaGuard } from "./quota/budget.js";
import { SessionManager, recoverInterrupted, sweepWorkspaces } from "./session/manager.js";
import { DiscordBot } from "./discord/bot.js";
import { Workspaces } from "./git/workspaces.js";
import { prepareExternalTools } from "./suunto/mcp.js";
import { ensureSuuntool } from "./suunto/install.js";
import { Scheduler } from "./schedule/scheduler.js";
import { createServer } from "./http/server.js";
import { Profiles, type Profile } from "./profile.js";
import { authorisesSomeone } from "./discord/authz.js";

async function main(): Promise<void> {
  const cfg = loadCore();
  const log = createLogger({ level: cfg.LOG_LEVEL, pretty: cfg.LOG_PRETTY });
  const creds = credentialSource(cfg);

  if (creds === "none") {
    log.error(
      "no Anthropic credentials configured — set CLAUDE_CODE_OAUTH_TOKEN " +
        "(generate with `claude setup-token`) or ANTHROPIC_API_KEY",
    );
    process.exit(1);
  }
  if (creds === "inherited-env") {
    log.warn("AGENT_INHERIT_ENV is on — dev only; the agent can read every env var this process holds");
  }

  const discord = requireDiscord();

  mkdirSync(cfg.workspacesDir, { recursive: true });
  mkdirSync(dirname(cfg.sqlitePath), { recursive: true });

  const store = openStore(cfg.sqlitePath);
  const quota = new QuotaGuard(cfg, log, store);

  // One binary for everyone; a failure disables Suunto tools and is logged,
  // but does not stop the bot.
  const suuntool = await ensureSuuntool(cfg, log);

  // One of each per profile. A profile that cannot work is skipped with a
  // reason, so one person's misconfiguration does not take the other's bot
  // down with it.
  const profiles: Profile[] = [];
  for (const p of loadProfiles()) {
    const plog = log.child({ profile: p.name });
    if (!p.remoteUrl) {
      plog.error("no repository — set GIT_REPO (owner/name); profile skipped");
      continue;
    }
    // Either a channel of its own (Discord's permissions decide who is in it)
    // or an explicit allowlist. Neither would mean anyone on the server could
    // spend the subscription, so the profile is skipped.
    if (
      !authorisesSomeone({
        userIds: p.DISCORD_CHAT_USER_IDS,
        roleIds: p.DISCORD_CHAT_ROLE_IDS,
        channelGated: p.DISCORD_CHAT_CHANNEL_IDS.length > 0,
      })
    ) {
      plog.error("no DISCORD_CHAT_CHANNEL_IDS and no allowlist — anyone could use this profile; skipped");
      continue;
    }

    const pcfg: Config = configFor(cfg, p);
    const workspaces = new Workspaces(pcfg, plog);

    // Resolve the base branch now, so a wrong repository or a bad token is a
    // startup error in the log rather than the first thing a thread says.
    let base = "unknown";
    try {
      base = await workspaces.baseBranch();
    } catch (e) {
      plog.error({ err: e, repo: p.GIT_REPO }, "cannot reach the repository — this profile's threads will fail until fixed");
    }

    const external = await prepareExternalTools(pcfg, log, suuntool);
    const manager = new SessionManager({ cfg: pcfg, log: plog, store, workspaces, external, quota });
    profiles.push({ cfg: pcfg, workspaces, manager });

    plog.info(
      {
        repo: p.GIT_REPO ?? p.GIT_REMOTE_URL,
        base,
        timeZone: p.BOT_TIMEZONE,
        channels: p.DISCORD_CHAT_CHANNEL_IDS.length || "any",
        allowlist: p.DISCORD_CHAT_USER_IDS.length + p.DISCORD_CHAT_ROLE_IDS.length || "channel members",
        suuntool: external.suuntoSource ?? "disabled",
        liftosaur: external.hasLiftosaur ? "enabled" : "disabled",
      },
      "profile ready",
    );
  }

  if (profiles.length === 0) {
    log.error("no usable profile — nothing to serve");
    process.exit(1);
  }
  if (profiles.length > 1) {
    const unowned = profiles.filter((p) => p.cfg.DISCORD_CHAT_CHANNEL_IDS.length === 0).map((p) => p.cfg.name);
    if (unowned.length > 0) {
      log.error({ profiles: unowned }, "with several profiles each needs DISCORD_CHAT_CHANNEL_IDS — these own no channel");
    }
  }
  const all = new Profiles(profiles);

  // A single-person installation that has just been given named profiles has
  // rows stamped `default`. They belong to the first profile — that is the
  // same person, renamed — so stamp them properly instead of relying on the
  // fallback forever (and so `threads` lists them).
  if (!profiles.some((p) => p.cfg.name === "default")) {
    const to = all.first.cfg.name;
    const moved = store.sessions.relabelProfile("default", to) + store.schedules.relabelProfile("default", to);
    if (moved > 0) log.info({ to, rows: moved }, "adopted rows from the pre-profile installation");
  }

  log.info(
    {
      model: cfg.AGENT_MODEL ?? "default",
      credentials: creds,
      profiles: profiles.map((p) => p.cfg.name),
      workspaces: cfg.workspacesDir,
      db: cfg.sqlitePath,
      suuntool: suuntool?.source ?? "disabled",
      turnsPerHour: cfg.AGENT_TURNS_PER_HOUR,
      maxConcurrent: cfg.AGENT_MAX_CONCURRENT_RUNS,
    },
    "fitcordllm starting",
  );

  // Recovery runs before the gateway connects, so nothing races it.
  const recovered = recoverInterrupted(store, log);

  const bot = new DiscordBot({ cfg, discord, log, store, profiles: all });
  await bot.start(recovered.interrupted);

  const byProfile = new Map(profiles.map((p) => [p.cfg.name, p.workspaces]));
  const scheduler = new Scheduler(
    cfg,
    log,
    store,
    (s) => all.named(s.profile).cfg.BOT_TIMEZONE,
    (s) => {
      void bot.postBrief(s).catch((e: unknown) => log.error({ err: e, schedule: s.name }, "brief failed"));
    },
    () => sweepWorkspaces(store, byProfile, all.first.workspaces),
  );
  scheduler.start();

  // HTTP binds after Discord so /readyz is only green once the bot can be reached.
  const server = createServer({ quota, isReady: () => bot.isConnected() });
  server.listen(cfg.HTTP_PORT, cfg.HTTP_BIND, () => {
    log.info({ port: cfg.HTTP_PORT, bind: cfg.HTTP_BIND }, "http listening");
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    scheduler.stop();
    server.close();
    void bot
      .stop()
      .catch(() => undefined)
      .finally(() => {
        store.close();
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // A misconfigured environment is an operator error; a stack trace buries the
  // one line that says which variable is missing.
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.stack : String(err));
  }
  process.exit(1);
});
