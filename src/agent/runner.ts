import {
  query,
  type Options,
  type SDKMessage,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";

export interface AgentSink {
  onSession?(sessionId: string): void;
  onText?(text: string): void;
  onToolUse?(name: string, input: unknown, id: string): void;
  /**
   * Claude Code's own plain-language summary of a group of tool calls,
   * arriving a few seconds after them. Only emitted when
   * CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES is set (config.ts sets it).
   */
  onToolSummary?(summary: string, toolUseIds: readonly string[]): void;
  onThinking?(): void;
  /**
   * Subscription rate-limit telemetry. This is the server stating the limit
   * rather than us guessing at it, so it is the authoritative input to the
   * quota cooldown — a `seven_day_opus` exhaustion is invisible to any
   * per-hour counter we keep ourselves.
   */
  onRateLimit?(info: SDKRateLimitInfo): void;
}

interface RunUsage {
  /** SDK turns consumed. The currency the hourly budget is denominated in. */
  readonly numTurns: number;
  readonly costUsd: number;
}

export type RunOutcome =
  | ({ readonly ok: true; readonly sessionId: string | undefined; readonly result: string } & RunUsage)
  | ({
      readonly ok: false;
      readonly sessionId: string | undefined;
      /** Present when the failure arrived as a result message rather than a throw. */
      readonly subtype?: string;
      readonly error: string;
      /** Stopped on maxTurns — in a write phase this means changes may have landed. */
      readonly exhaustedTurns: boolean;
      /** Last rate-limit report seen, if the failure was quota-related. */
      readonly rateLimit?: SDKRateLimitInfo;
    } & RunUsage);

/**
 * Drives one query() to completion.
 *
 * Two details are load-bearing:
 *
 * - The session id is captured from the first `system/init` message and reported
 *   to the sink immediately, because a single-shot query() throws *after*
 *   yielding an error result. Losing the id would orphan the session and make
 *   resume impossible.
 * - Failures report `numTurns`/`costUsd` too. A run that dies on `error_max_turns`
 *   is the single most expensive thing this system can do, and accounting it as
 *   zero would let a budget check wave through the next one.
 */
export async function runQuery(
  prompt: string,
  options: Options,
  sink: AgentSink = {},
  shouldStop?: () => boolean,
): Promise<RunOutcome> {
  let sessionId: string | undefined;
  let rateLimit: SDKRateLimitInfo | undefined;

  try {
    for await (const message of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        sink.onSession?.(sessionId);
        continue;
      }

      if (message.type === "tool_use_summary") {
        sink.onToolSummary?.(message.summary, message.preceding_tool_use_ids);
        continue;
      }

      if (message.type === "rate_limit_event") {
        rateLimit = message.rate_limit_info;
        sink.onRateLimit?.(rateLimit);
        continue;
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") sink.onText?.(block.text);
          else if (block.type === "tool_use") sink.onToolUse?.(block.name, block.input, block.id);
          else if (block.type === "thinking") sink.onThinking?.();
        }
        if (shouldStop?.()) {
          return {
            ok: false,
            sessionId,
            error: "run aborted by operator",
            exhaustedTurns: false,
            numTurns: 0,
            costUsd: 0,
            ...(rateLimit ? { rateLimit } : {}),
          };
        }
        continue;
      }

      if (message.type === "result") {
        sessionId ??= message.session_id;
        const usage: RunUsage = { numTurns: message.num_turns, costUsd: message.total_cost_usd };

        if (message.subtype === "success") {
          return { ok: true, sessionId, result: message.result, ...usage };
        }
        // error_during_execution | error_max_turns | error_max_budget_usd |
        // error_max_structured_output_retries
        return {
          ok: false,
          sessionId,
          subtype: message.subtype,
          error: `agent run ended with ${message.subtype}`,
          exhaustedTurns: message.subtype === "error_max_turns",
          ...usage,
          ...(rateLimit ? { rateLimit } : {}),
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      sessionId,
      error: e instanceof Error ? e.message : String(e),
      exhaustedTurns: false,
      // A throw gives us no usage report. Turns were still spent, so callers
      // that bill a budget should treat this as an unknown-but-nonzero charge.
      numTurns: 0,
      costUsd: 0,
      ...(rateLimit ? { rateLimit } : {}),
    };
  }

  return {
    ok: false,
    sessionId,
    error: "agent stream ended without a result message",
    exhaustedTurns: false,
    numTurns: 0,
    costUsd: 0,
    ...(rateLimit ? { rateLimit } : {}),
  };
}
