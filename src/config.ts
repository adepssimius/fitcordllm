import { join } from "node:path";
import { z } from "zod";

/**
 * Config is split so the headless dev REPL can run with only Anthropic
 * credentials and a repository. Discord settings are validated lazily via
 * requireDiscord() rather than at import time.
 *
 * Nothing personal has a default here. This repository is public; guild ids,
 * account names and the repository being worked on all come from the
 * environment.
 */

const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

/** Treats an empty string as unset, which is how an unfilled ConfigMap key arrives. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const CoreSchema = z.object({
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  LOG_PRETTY: bool,

  /**
   * Credentials. Exactly one is needed; the SDK resolves in this order.
   *
   * CLAUDE_CODE_OAUTH_TOKEN is the subscription path: generate it once with
   * `claude setup-token`, then store it as a Secret. It draws on subscription
   * rate limits, which is why the quota settings below exist.
   */
  CLAUDE_CODE_OAUTH_TOKEN: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_AUTH_TOKEN: optionalString,
  /**
   * DEV ONLY. Forwards the whole parent environment to the agent subprocess.
   * Needed when iterating inside an environment that brokers credentials
   * through env vars (a nested Claude Code session). Never set it in the
   * cluster: it would hand the agent the Discord and GitHub tokens.
   */
  AGENT_INHERIT_ENV: bool,
  /** Unset means the Claude Code default for the account. */
  AGENT_MODEL: optionalString,
  /**
   * SDK turns one Discord message may spend. Authoring a training week is a
   * few dozen file writes, so this is far higher than a question needs.
   */
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(80),
  /** Built-in tools the agent may use, beyond the MCP servers. */
  AGENT_BUILTIN_TOOLS: z
    .string()
    .default("Read,Write,Edit,Glob,Grep,Bash,WebSearch,Skill,TodoWrite")
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),

  /** Everything that must survive a restart lives under here. */
  DATA_DIR: z.string().default("/data"),
  SQLITE_PATH: optionalString,
  WORKSPACES_DIR: optionalString,

  /**
   * Quota. On subscription auth these are availability controls, not cost
   * controls: exhausting the limit locks the operator out of their own editor.
   */
  AGENT_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),
  /** Budget denominated in SDK turns, the same unit the ledger records. */
  AGENT_TURNS_PER_HOUR: z.coerce.number().int().positive().default(300),
  /** Assumed cost of a run already in flight, so simultaneous starts can't all see zero. */
  AGENT_INFLIGHT_TURN_ESTIMATE: z.coerce.number().int().positive().default(10),
  /** Utilization (0–1) at which concurrency drops to 1 and a warning is posted. */
  QUOTA_WARN_UTILIZATION: z.coerce.number().min(0).max(1).default(0.8),

  /**
   * Where the Suunto CLI comes from. The default is upstream; point
   * SUUNTOOL_REPO at a fork to run a build with a feature upstream lacks. The
   * release for SUUNTOOL_VERSION is downloaded once and cached under DATA_DIR.
   */
  SUUNTOOL_REPO: z.string().default("tajchert/suuntool"),
  /** A release tag, or `latest`. */
  SUUNTOOL_VERSION: z.string().default("latest"),
  /** Use this binary and skip the download entirely. */
  SUUNTOOL_BIN: optionalString,
  /** Sent when resolving releases — only needed for a private fork. */
  SUUNTOOL_GITHUB_TOKEN: optionalString,
  SUUNTOOL_MCP_ARGS: z.string().default("mcp --allow-write --allow-destructive"),
  GIT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * A workspace with nothing unshipped is deleted after this long without a
   * turn. The thread itself stays resumable: the clone is recreated at the
   * same path the next time someone writes in it.
   */
  WORKSPACE_IDLE_DAYS: z.coerce.number().int().positive().default(14),
  /** How often the scheduler looks for due briefs. */
  SCHEDULE_TICK_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * A brief that is this late (the pod was down) is skipped rather than run:
   * a morning brief delivered at dinner is noise.
   */
  SCHEDULE_MAX_LATE_MS: z.coerce.number().int().positive().default(3 * 3_600_000),
  /** Refuse schedules that would fire more often than this. */
  SCHEDULE_MIN_INTERVAL_MIN: z.coerce.number().int().positive().default(30),

  /** How long a poll stays open if nobody answers it. Discord's minimum is 1. */
  POLL_DURATION_HOURS: z.coerce.number().int().min(1).max(768).default(24),
  /**
   * How long after the last tap before a vote is taken as final. Short for a
   * single choice — just long enough to fix a mis-tap — and longer when
   * several answers may be picked, since each one is a separate tap.
   */
  POLL_SETTLE_MS: z.coerce.number().int().nonnegative().default(4_000),
  POLL_MULTI_SETTLE_MS: z.coerce.number().int().nonnegative().default(15_000),

  HTTP_PORT: z.coerce.number().int().positive().default(8080),
  HTTP_BIND: z.string().default("0.0.0.0"),
});

const DiscordSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_EDIT_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  DISCORD_MAX_MESSAGES_PER_TURN: z.coerce.number().int().positive().default(30),
  CHAT_PENDING_MAX: z.coerce.number().int().positive().default(5),
});


/**
 * One person's setup. A single bot process serves several of these: each has
 * its own Discord channel, repository, Suunto account and (optionally)
 * Liftosaur, and they share everything else — the bot identity, the Claude
 * subscription and its quota guard, the database and the volume.
 *
 * Every field here can be set two ways: plainly (`GIT_REPO`), which is the
 * default for every profile, or per profile (`PROFILE_<NAME>_GIT_REPO`), which
 * wins for that profile. `FITCORD_PROFILES` names the profiles; unset, there is
 * one profile called `default` read from the plain variables, which is how a
 * single-person deployment was configured before profiles existed.
 */
const ProfileSchema = z.object({
  /**
   * The repository each thread works in, as `owner/name` on GitHub.
   * GIT_REMOTE_URL overrides the derived URL — tests and local development
   * point it at a bare repository on disk.
   */
  GIT_REPO: optionalString,
  GIT_REMOTE_URL: optionalString,
  /** Unset means whatever the remote's HEAD points at. */
  GIT_BASE_BRANCH: optionalString,
  GIT_BRANCH_PREFIX: z.string().default("fitcord"),
  /** Held by the bot process only. No agent tool or subprocess receives it. */
  GITHUB_TOKEN: optionalString,
  GIT_AUTHOR_NAME: z.string().default("fitcordllm"),
  GIT_AUTHOR_EMAIL: z.string().default("fitcordllm@users.noreply.github.com"),
  /**
   * Repository instructions appended to the system prompt, relative to the
   * workspace root. Skipped when the file is missing or a CLAUDE.md exists
   * (Claude Code loads that one by itself).
   */
  REPO_INSTRUCTIONS_FILE: z.string().default("AGENTS.md"),

  /** IANA zone for schedules and for the date the agent is told it is. */
  BOT_TIMEZONE: z.string().default("UTC"),

  /** The session key is the secret; the rest are cosmetic or TOTP inputs. */
  SUUNTOOL_SESSION_KEY: optionalString,
  SUUNTOOL_EMAIL: optionalString,
  SUUNTOOL_USERNAME: optionalString,
  SUUNTOOL_USER_KEY: optionalString,
  SUUNTOOL_COUNTRY: optionalString,
  SUUNTOOL_OFFSET_MS: z.coerce.number().int().default(0),

  LIFTOSAUR_API_KEY: optionalString,
  LIFTOSAUR_MCP_URL: z.string().default("https://www.liftosaur.com/mcp"),

  /**
   * Who may cause an agent turn. Optional when the profile has its own
   * channel: Discord's permissions on a private channel already decide who
   * can post there. Required when it answers in any channel.
   */
  DISCORD_CHAT_ROLE_IDS: csv,
  DISCORD_CHAT_USER_IDS: csv,
  /**
   * The channel(s) this profile answers in. With one profile, empty means any
   * channel; with several, a profile with no channel owns nothing.
   */
  DISCORD_CHAT_CHANNEL_IDS: csv,
  /** Where scheduled briefs are posted unless the schedule names a channel. */
  DISCORD_BRIEF_CHANNEL_ID: optionalString,
});

type ProfileParsed = z.infer<typeof ProfileSchema>;

export interface ProfileConfig extends ProfileParsed {
  /** `default`, or a name from FITCORD_PROFILES. Stored on every session and schedule. */
  readonly name: string;
  /** Where the bot's own git calls fetch from and push to. */
  readonly remoteUrl: string | undefined;
}

/** The shared settings plus one profile's — what everything working on behalf of one person takes. */
export type Config = CoreConfig & ProfileConfig;

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

type CoreParsed = z.infer<typeof CoreSchema>;

export interface CoreConfig extends CoreParsed {
  readonly sqlitePath: string;
  readonly workspacesDir: string;
}

export type DiscordConfig = z.infer<typeof DiscordSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function describe(error: z.ZodError): string {
  return error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

let cached: CoreConfig | undefined;

export function loadCore(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  if (cached && env === process.env) return cached;
  const parsed = CoreSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(`invalid configuration:\n${describe(parsed.error)}`);
  const c = parsed.data;
  const cfg: CoreConfig = {
    ...c,
    sqlitePath: c.SQLITE_PATH ?? join(c.DATA_DIR, "fitcordllm.db"),
    workspacesDir: c.WORKSPACES_DIR ?? join(c.DATA_DIR, "threads"),
  };
  if (env === process.env) cached = cfg;
  return cfg;
}

export function resetConfigCache(): void {
  cached = undefined;
}

/** `PROFILE_<NAME>_` with the name upper-cased and dashes turned to underscores. */
export function profileEnvPrefix(name: string): string {
  return `PROFILE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
}

/**
 * Reads every profile. A per-profile variable wins over the plain one, so the
 * plain variables are the defaults shared by all profiles.
 */
export function loadProfiles(env: NodeJS.ProcessEnv = process.env): ProfileConfig[] {
  const names = (env.FITCORD_PROFILES ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const list = names.length > 0 ? names : ["default"];

  const seen = new Set<string>();
  return list.map((name) => {
    if (!PROFILE_NAME.test(name)) {
      throw new ConfigError(`invalid configuration:\n  FITCORD_PROFILES: '${name}' — lowercase letters, digits and dashes only`);
    }
    if (seen.has(name)) throw new ConfigError(`invalid configuration:\n  FITCORD_PROFILES: '${name}' is listed twice`);
    seen.add(name);

    const prefix = names.length > 0 ? profileEnvPrefix(name) : null;
    const raw: Record<string, string | undefined> = {};
    for (const key of Object.keys(ProfileSchema.shape)) {
      const own = prefix ? env[`${prefix}${key}`] : undefined;
      raw[key] = own !== undefined && own !== "" ? own : env[key];
    }

    const parsed = ProfileSchema.safeParse(raw);
    if (!parsed.success) throw new ConfigError(`invalid configuration for profile '${name}':\n${describe(parsed.error)}`);
    const p = parsed.data;

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: p.BOT_TIMEZONE });
    } catch {
      throw new ConfigError(
        `invalid configuration for profile '${name}':\n  BOT_TIMEZONE: '${p.BOT_TIMEZONE}' is not an IANA time zone`,
      );
    }

    return {
      ...p,
      name,
      remoteUrl: p.GIT_REMOTE_URL ?? (p.GIT_REPO ? `https://github.com/${p.GIT_REPO}.git` : undefined),
    };
  });
}

/** The shared settings merged with one profile's. */
export function configFor(core: CoreConfig, profile: ProfileConfig): Config {
  return { ...core, ...profile };
}

/** Shared settings plus the first (or only) profile — for the dev REPL and tests. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const core = loadCore(env);
  const first = loadProfiles(env)[0];
  if (!first) throw new ConfigError("no profiles configured");
  return configFor(core, first);
}

export function requireDiscord(env: NodeJS.ProcessEnv = process.env): DiscordConfig {
  const parsed = DiscordSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(`invalid Discord configuration:\n${describe(parsed.error)}`);
  return parsed.data;
}

/**
 * The environment handed to the agent subprocess — and therefore to every
 * Bash command it runs.
 *
 * Deliberately a short allowlist. The Discord token and the GitHub token are
 * never in it: the bot process alone talks to Discord and pushes to the
 * repository. What cannot be withheld is the Anthropic credential, because the
 * subprocess is the thing that uses it.
 */
export function sanitizedEnv(
  cfg: Config,
  extra: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (cfg.AGENT_INHERIT_ENV) {
    const inherited: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) inherited[k] = v;
    return { ...inherited, ...extra };
  }

  const out: Record<string, string> = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TZ: cfg.BOT_TIMEZONE,
    // Without these git inside the workspace refuses to stash or commit, and
    // prompts on a terminal that does not exist.
    GIT_TERMINAL_PROMPT: "0",
    // The agent runs the repository's Python scripts. Bytecode caches written
    // into the clone would show up as unshipped files, and `ship` would
    // publish them.
    PYTHONDONTWRITEBYTECODE: "1",
    GIT_AUTHOR_NAME: cfg.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: cfg.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: cfg.GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: cfg.GIT_AUTHOR_EMAIL,
  };
  if (cfg.CLAUDE_CODE_OAUTH_TOKEN) out.CLAUDE_CODE_OAUTH_TOKEN = cfg.CLAUDE_CODE_OAUTH_TOKEN;
  if (cfg.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = cfg.ANTHROPIC_API_KEY;
  if (cfg.ANTHROPIC_AUTH_TOKEN) out.ANTHROPIC_AUTH_TOKEN = cfg.ANTHROPIC_AUTH_TOKEN;
  // HOME is where the SDK writes session transcripts. In-cluster it is on the
  // persistent volume, which is what makes a thread resumable after a restart.
  if (env.HOME) out.HOME = env.HOME;
  return { ...out, ...extra };
}

export type CredentialSource = "oauth-token" | "api-key" | "auth-token" | "inherited-env" | "none";

/** Which credential the agent subprocess will actually use. Logged at startup. */
export function credentialSource(cfg: CoreConfig): CredentialSource {
  if (cfg.CLAUDE_CODE_OAUTH_TOKEN) return "oauth-token";
  if (cfg.ANTHROPIC_API_KEY) return "api-key";
  if (cfg.ANTHROPIC_AUTH_TOKEN) return "auth-token";
  if (cfg.AGENT_INHERIT_ENV) return "inherited-env";
  return "none";
}
