import type { HookCallback, HookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logger.js";
import { evaluate, type Decision } from "./policy.js";

export interface GateContext {
  readonly log: Logger;
  readonly workspaceDir: string;
  /** Consulted per call so a `stop` in Discord takes effect mid-run. */
  readonly isAborted?: () => boolean;
  readonly onDecision?: (event: GateEvent) => void;
}

export interface GateEvent {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly decision: Decision;
}

/**
 * PreToolUse hook factory.
 *
 * This runs before deny rules, the permission mode, and allow rules, so it is
 * the one gate that sees every tool call. Register it with no `matcher`: a
 * matcher-less hook runs for every event of its type.
 */
export function createGate(ctx: GateContext): HookCallback {
  return async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;

    const decision = evaluate({
      toolName: pre.tool_name,
      toolInput: pre.tool_input,
      workspaceDir: ctx.workspaceDir,
      ...(ctx.isAborted ? { aborted: ctx.isAborted() } : {}),
    });

    ctx.onDecision?.({ toolName: pre.tool_name, toolInput: pre.tool_input, decision });

    if (decision.allow) return {};

    ctx.log.warn({ tool: pre.tool_name, reason: decision.reason }, "tool denied by policy");
    return {
      systemMessage: `Blocked: ${decision.reason}`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: decision.reason,
      },
    };
  };
}
