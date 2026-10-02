import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import { sanitizedEnv, type CoreConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createGate, type GateEvent } from "./gate.js";
import { FITCORD_SERVER } from "./prompts.js";

/**
 * Every `Options` object in this process comes from `buildOptions`.
 *
 * The shape is the opposite of a read-only bot, on purpose: the agent's job is
 * to edit a repository and run its scripts, so it has file tools and Bash. What
 * keeps that contained is everything else on this object —
 *
 *  - `cwd` is the thread's own clone, and the gate keeps edits inside it;
 *  - `env` is a short allowlist with no Discord or GitHub token in it;
 *  - `strictMcpConfig` means the only MCP servers are the ones passed here, so
 *    a `.mcp.json` in the repository cannot add one;
 *  - `permissionMode: dontAsk` denies anything not listed rather than
 *    prompting, because a prompt in a headless pod is an indefinite hang.
 */

/** Session continuity. `resume` continues an SDK session; `sessionId` names a new one. */
export interface SessionIo {
  readonly resume?: string;
  readonly sessionId?: string;
}

export interface RunSpec extends SessionIo {
  readonly cfg: CoreConfig;
  readonly log: Logger;
  /** The thread's clone. Must be the same path on every turn, or resume breaks. */
  readonly workspaceDir: string;
  /** Appended to Claude Code's own system prompt. */
  readonly systemAppend: string;
  /** External servers (Suunto, Liftosaur), keyed by name. */
  readonly externalServers: Readonly<Record<string, McpServerConfig>>;
  /** The bot's in-process server, and the tool names it registered this turn. */
  readonly fitcordServer: McpServerConfig;
  readonly fitcordTools: readonly string[];
  /** Extra environment for the subprocess, e.g. where the Suunto session file is. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly isAborted?: () => boolean;
  readonly onDecision?: (e: GateEvent) => void;
}

/**
 * Subagents run outside the gate, WebFetch makes requests from inside the pod
 * network to wherever the model points it, and there are no notebooks here.
 */
export const BUILTIN_DENY = ["Task", "Agent", "WebFetch", "NotebookEdit"] as const;

export function buildOptions(spec: RunSpec): Options {
  if (spec.resume && spec.sessionId) {
    throw new Error("buildOptions: `resume` and `sessionId` are mutually exclusive");
  }
  const { cfg } = spec;

  const denied = new Set<string>(BUILTIN_DENY);
  const builtins = cfg.AGENT_BUILTIN_TOOLS.filter((t) => !denied.has(t));

  // A bare `mcp__<server>` entry allows every tool that server offers. The
  // external servers are the person's own accounts; which of their tools exist
  // is decided by how the server is started (see suunto/mcp.ts), not here.
  const externalAllow = Object.keys(spec.externalServers).flatMap((name) => [
    `mcp__${name}`,
    `mcp__${name}__*`,
  ]);

  return {
    ...(cfg.AGENT_MODEL ? { model: cfg.AGENT_MODEL } : {}),
    cwd: spec.workspaceDir,
    systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemAppend },
    // Project only: the repository's own skills and settings are part of what
    // the agent is here to work with. Never `user` — on a persistent volume a
    // user-level settings file is something an earlier run could have written.
    settingSources: ["project"],
    skills: "all",
    strictMcpConfig: true,
    permissionMode: "dontAsk",

    tools: [...builtins],
    disallowedTools: [...BUILTIN_DENY],
    allowedTools: [...builtins, ...externalAllow, ...spec.fitcordTools],

    mcpServers: { ...spec.externalServers, [FITCORD_SERVER]: spec.fitcordServer },

    // No `matcher`: a matcher-less hook runs for every event of its type,
    // which is what a universal gate needs.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            createGate({
              log: spec.log,
              workspaceDir: spec.workspaceDir,
              ...(spec.isAborted ? { isAborted: spec.isAborted } : {}),
              ...(spec.onDecision ? { onDecision: spec.onDecision } : {}),
            }),
          ],
        },
      ],
    },

    maxTurns: cfg.AGENT_MAX_TURNS,
    env: sanitizedEnv(cfg, spec.extraEnv ?? {}),
    ...(spec.resume ? { resume: spec.resume } : {}),
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
  };
}
