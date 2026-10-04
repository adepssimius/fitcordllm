import type { CanUseTool, McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import { sanitizedEnv, type Config } from "../config.js";
import type { Logger } from "../logger.js";
import { createGate, type GateEvent } from "./gate.js";
import { evaluate } from "./policy.js";
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
 *  - `canUseTool` answers the permission prompts Claude Code would otherwise
 *    show a person — see `answerPrompt` below.
 */

/** Session continuity. `resume` continues an SDK session; `sessionId` names a new one. */
export interface SessionIo {
  readonly resume?: string;
  readonly sessionId?: string;
}

export interface RunSpec extends SessionIo {
  readonly cfg: Config;
  readonly log: Logger;
  /** The thread's clone. Must be the same path on every turn, or resume breaks. */
  readonly workspaceDir: string;
  /** Appended to Claude Code's own system prompt. */
  readonly systemAppend: string;
  /** External servers (Suunto, Liftosaur), keyed by name. */
  readonly externalServers: Readonly<Record<string, McpServerConfig>>;
  /** The bot's in-process server, built for this turn with this turn's tools. */
  readonly fitcordServer: McpServerConfig;
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

/**
 * Answers Claude Code's permission prompts, since there is nobody to show
 * them to.
 *
 * Claude Code asks before touching paths it treats as sensitive: everything
 * under `.claude/` (skills, settings, commands, agents, hook scripts),
 * `.mcp.json`, editor folders such as `.vscode/`. An allow rule does not
 * settle that question and neither does a PreToolUse hook returning "allow" —
 * both were tried — so with `permissionMode: dontAsk` every such edit was
 * refused outright. That is how a scheduled brief came to be unable to edit
 * the daily-brief skill it was running from.
 *
 * In a session on a laptop the person at the keyboard says yes. Here the bot
 * does, on the same terms the gate already applies to every call: inside this
 * thread's clone, yes; outside it, inside `.git`, or a git command that would
 * bypass ship/sync, no. Tools the deny list removes never reach this point.
 */
export function answerPrompt(spec: Pick<RunSpec, "log" | "workspaceDir" | "isAborted">): CanUseTool {
  return async (toolName, input, opts) => {
    const decision = evaluate({
      toolName,
      toolInput: input,
      workspaceDir: spec.workspaceDir,
      ...(spec.isAborted ? { aborted: spec.isAborted() } : {}),
    });
    if (!decision.allow) {
      spec.log.warn({ tool: toolName, reason: decision.reason }, "permission prompt refused");
      return { behavior: "deny", message: decision.reason, toolUseID: opts.toolUseID };
    }
    // Every ordinary call lands here too (see allowedTools), so only the ones
    // Claude Code flagged as sensitive are worth a line at info.
    const flagged = opts.decisionReason !== undefined || opts.blockedPath !== undefined;
    spec.log[flagged ? "info" : "debug"](
      { tool: toolName, why: opts.decisionReason, path: opts.blockedPath },
      "permission prompt approved",
    );
    return { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID };
  };
}

export function buildOptions(spec: RunSpec): Options {
  if (spec.resume && spec.sessionId) {
    throw new Error("buildOptions: `resume` and `sessionId` are mutually exclusive");
  }
  const { cfg } = spec;

  const denied = new Set<string>(BUILTIN_DENY);
  const builtins = cfg.AGENT_BUILTIN_TOOLS.filter((t) => !denied.has(t));

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
    // `default`, not `dontAsk`: what would be a prompt goes to canUseTool
    // below instead of being refused. Nothing ever waits on a person.
    permissionMode: "default",
    canUseTool: answerPrompt(spec),

    // What the agent can call is decided by what exists, not by an allow
    // list: the builtins named here, and the tools of the servers below —
    // which for the bot's own server differ per turn (a scheduled run is
    // given no ship tool at all; see tools/fitcord.ts). Everything else is a
    // question for canUseTool. allowedTools stays empty on purpose: any entry
    // there approves its tool before canUseTool is asked, and the SDK warns
    // about exactly that on every query.
    tools: [...builtins],
    disallowedTools: [...BUILTIN_DENY],
    allowedTools: [],

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
