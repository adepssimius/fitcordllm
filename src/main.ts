import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, credentialSource, loadCore, requireDiscord } from "./config.js";
import { createLogger } from "./logger.js";
import { openStore } from "./store/index.js";
import { QuotaGuard } from "./quota/budget.js";
import { SessionManager } from "./session/manager.js";
import { DiscordBot } from "./discord/bot.js";
import { Workspaces } from "./git/workspaces.js";
import { prepareExternalTools } from "./suunto/mcp.js";
import { Scheduler } from "./schedule/scheduler.js";
import { createServer } from "./http/server.js";

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
  if (discord.DISCORD_CHAT_ROLE_IDS.length === 0 && discord.DISCORD_CHAT_USER_IDS.length === 0) {
    // Fail closed and say why: turns spend the operator's own subscription.
    log.error("set DISCORD_CHAT_ROLE_IDS or DISCORD_CHAT_USER_IDS — nobody can use the bot otherwise");
    process.exit(1);
  }
  if (!cfg.remoteUrl) {
    log.error("set GIT_REPO (owner/name) — every thread works in a clone of it");
    process.exit(1);
  }

  mkdirSync(cfg.workspacesDir, { recursive: true });
  mkdirSync(dirname(cfg.sqlitePath), { recursive: true });

  const store = openStore(cfg.sqlitePath);
  const quota = new QuotaGuard(cfg, log, store);
  const workspaces = new Workspaces(cfg, log);

  // Resolve the base branch now, so a wrong repository or a bad token is a
  // startup error in the log rather than the first thing a thread says.
  let base = "unknown";
  try {
    base = await workspaces.baseBranch();
  } catch (e) {
    log.error({ err: e, repo: cfg.GIT_REPO }, "cannot reach the repository — threads will fail until this is fixed");
  }

  // Downloads the Suunto CLI on first start; a failure disables those tools
  // and is logged, but does not stop the bot.
  const external = await prepareExternalTools(cfg, log);

  const manager = new SessionManager({ cfg, log, store, workspaces, external, quota });

  log.info(
    {
      model: cfg.AGENT_MODEL ?? "default",
      credentials: creds,
      repo: cfg.GIT_REPO ?? cfg.GIT_REMOTE_URL,
      base,
      workspaces: cfg.workspacesDir,
      db: cfg.sqlitePath,
      timeZone: cfg.BOT_TIMEZONE,
      suuntool: external.suuntoSource ?? "disabled",
      liftosaur: external.hasLiftosaur ? "enabled" : "disabled",
      turnsPerHour: cfg.AGENT_TURNS_PER_HOUR,
      maxConcurrent: cfg.AGENT_MAX_CONCURRENT_RUNS,
      chatChannels: discord.DISCORD_CHAT_CHANNEL_IDS.length || "any",
    },
    "fitcordllm starting",
  );

  // Recovery runs before the gateway connects, so nothing races it.
  const recovered = manager.recover();

  const bot = new DiscordBot({ cfg, discord, log, store, manager, workspaces });
  await bot.start(recovered.interrupted);

  const scheduler = new Scheduler(
    cfg,
    log,
    store,
    (s) => {
      void bot.postBrief(s).catch((e: unknown) => log.error({ err: e, schedule: s.name }, "brief failed"));
    },
    () => manager.sweepWorkspaces(),
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
