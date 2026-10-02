import { pino, type Logger } from "pino";

/**
 * A backstop, not the primary control: nothing should log a whole config
 * object, and this catches the day something does.
 */
const SECRETS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "DISCORD_BOT_TOKEN",
  "GITHUB_TOKEN",
  "SUUNTOOL_GITHUB_TOKEN",
  "SUUNTOOL_SESSION_KEY",
  "SUUNTOOL_USER_KEY",
  "LIFTOSAUR_API_KEY",
];

const REDACT_PATHS = [
  ...SECRETS,
  ...SECRETS.map((s) => `*.${s}`),
  "headers.authorization",
  "headers.Authorization",
];

export function createLogger(opts: { level: string; pretty: boolean }): Logger {
  return pino({
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(opts.pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  });
}

export type { Logger };
