import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { CoreConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { ensureSuuntool } from "./install.js";

/**
 * The MCP servers that reach the person's own accounts, built once at startup.
 *
 * These are defined here rather than read from the repository's `.mcp.json`.
 * The binary's location is this bot's business (see install.ts), and a server
 * list the repository could change is a server list a stray commit could
 * change. `strictMcpConfig` in agent/options.ts makes this the whole list.
 */

export const SUUNTO_SERVER = "suuntool";
export const LIFTOSAUR_SERVER = "liftosaur";

export interface ExternalTools {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  /** Added to the agent's environment so the `suuntool` CLI also works from Bash. */
  readonly env: Readonly<Record<string, string>>;
  readonly hasSuunto: boolean;
  readonly hasLiftosaur: boolean;
  /** For the startup log. */
  readonly suuntoSource: string | undefined;
}

/** The shape suuntool reads; field names are its own. */
export function sessionJson(cfg: CoreConfig, now: Date = new Date()): string {
  return `${JSON.stringify(
    {
      sessionkey: cfg.SUUNTOOL_SESSION_KEY ?? "",
      username: cfg.SUUNTOOL_USERNAME ?? "",
      email: cfg.SUUNTOOL_EMAIL ?? "",
      userKey: cfg.SUUNTOOL_USER_KEY ?? "",
      country: cfg.SUUNTOOL_COUNTRY ?? "",
      server_time_offset_ms: cfg.SUUNTOOL_OFFSET_MS,
      saved_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
    null,
    2,
  )}\n`;
}

/**
 * Writes suuntool's session file from the environment.
 *
 * Rewritten on every start, so rotating the key is "change the secret and
 * restart" — there is no stale copy on the volume to outlive it.
 */
async function writeSession(cfg: CoreConfig): Promise<string> {
  const path = join(cfg.DATA_DIR, "suuntool", "session.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, sessionJson(cfg), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function prepareExternalTools(cfg: CoreConfig, log: Logger): Promise<ExternalTools> {
  const servers: Record<string, McpServerConfig> = {};
  const env: Record<string, string> = {};
  let suuntoSource: string | undefined;

  if (!cfg.SUUNTOOL_SESSION_KEY) {
    log.warn("SUUNTOOL_SESSION_KEY is unset — Suunto tools disabled");
  } else {
    const installed = await ensureSuuntool(cfg, log);
    if (installed) {
      const sessionFile = await writeSession(cfg);
      const binDir = dirname(installed.bin);
      env.SUUNTOOL_SESSION_FILE = sessionFile;
      env.PATH = `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
      servers[SUUNTO_SERVER] = {
        type: "stdio",
        command: installed.bin,
        args: cfg.SUUNTOOL_MCP_ARGS.split(/\s+/).filter((a) => a.length > 0),
        env: { SUUNTOOL_SESSION_FILE: sessionFile },
      };
      suuntoSource = installed.source;
    }
  }

  if (cfg.LIFTOSAUR_API_KEY) {
    servers[LIFTOSAUR_SERVER] = {
      type: "http",
      url: cfg.LIFTOSAUR_MCP_URL,
      headers: { Authorization: `Bearer ${cfg.LIFTOSAUR_API_KEY}` },
    };
  } else {
    log.warn("LIFTOSAUR_API_KEY is unset — Liftosaur tools disabled");
  }

  return {
    servers,
    env,
    hasSuunto: SUUNTO_SERVER in servers,
    hasLiftosaur: LIFTOSAUR_SERVER in servers,
    suuntoSource,
  };
}
