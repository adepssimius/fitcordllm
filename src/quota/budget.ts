import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { CoreConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { Store } from "../store/index.js";
import { Semaphore } from "../util/semaphore.js";

/**
 * Subscription quota protection.
 *
 * Three layers, and they are not redundant:
 *
 *  1. Hourly SDK-turn budget — our own ledger, with an in-flight reservation so
 *     runs starting in the same second cannot all observe a spend of zero.
 *  2. Concurrency — a semaphore whose limit drops to 1 while utilization is high.
 *  3. Reactive cooldown driven by `rate_limit_event` — the server stating the
 *     limit rather than us guessing at it. This is the load-bearing layer: a
 *     `seven_day_opus` exhaustion is invisible to any per-hour counter, so you
 *     can sit well under budget and still be locked out for days.
 *
 * The cooldown is persisted, so a restart does not immediately re-probe an
 * exhausted limit.
 */

const COOLDOWN_KEY = "quota.cooldown";
const WARN_KEY_PREFIX = "quota.warned.";

export interface Cooldown {
  readonly until: number;
  readonly rateLimitType: string | null;
  readonly recordedAt: number;
}

export type QuotaVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "cooldown";
      /** Epoch ms. Render with Discord's <t:seconds:R> so it stays accurate. */
      readonly until: number;
      readonly rateLimitType: string | null;
    }
  | {
      readonly allowed: false;
      readonly reason: "hourly-budget";
      readonly spent: number;
      readonly limit: number;
      readonly retryAt: number;
    };

export interface QuotaStatus {
  readonly spentLastHour: number;
  readonly hourlyLimit: number;
  readonly inFlight: number;
  readonly concurrencyLimit: number;
  readonly queued: number;
  readonly cooldown: Cooldown | null;
}

export interface QuotaEvents {
  /** Fired once per rate-limit type per window when utilization crosses the threshold. */
  onWarning?(info: SDKRateLimitInfo, message: string): void;
  /** Fired when the subscription limit is refused outright. */
  onCooldown?(cooldown: Cooldown, message: string): void;
  onCooldownCleared?(): void;
}

export class QuotaGuard {
  readonly semaphore: Semaphore;
  private lastUtilization = new Map<string, number>();

  constructor(
    private readonly cfg: CoreConfig,
    private readonly log: Logger,
    private readonly store: Store,
    private readonly events: QuotaEvents = {},
  ) {
    this.semaphore = new Semaphore(cfg.AGENT_MAX_CONCURRENT_RUNS);
  }

  /**
   * Must be called BEFORE the turn row is written, so a refused run leaves no
   * `running` turn for restart recovery to clean up and spends nothing.
   */
  check(now = Date.now()): QuotaVerdict {
    const cooldown = this.cooldown();
    if (cooldown && cooldown.until > now) {
      return {
        allowed: false,
        reason: "cooldown",
        until: cooldown.until,
        rateLimitType: cooldown.rateLimitType,
      };
    }
    if (cooldown && cooldown.until <= now) this.clearCooldown();

    const windowStart = now - 3_600_000;
    const spent = this.store.turns.agentTurnsSince(windowStart);
    // Reserve for runs already in flight; without this, three simultaneous
    // starts all read the same pre-spend total and sail through.
    const reserved = this.store.turns.runningCount() * this.cfg.AGENT_INFLIGHT_TURN_ESTIMATE;

    if (spent + reserved >= this.cfg.AGENT_TURNS_PER_HOUR) {
      return {
        allowed: false,
        reason: "hourly-budget",
        spent,
        limit: this.cfg.AGENT_TURNS_PER_HOUR,
        // The window slides, so capacity returns gradually; the oldest turn in
        // the window ageing out is the earliest meaningful retry.
        retryAt: now + 5 * 60_000,
      };
    }

    return { allowed: true };
  }

  /** Consumes the SDK's own rate-limit telemetry. */
  onRateLimit(info: SDKRateLimitInfo, now = Date.now()): void {
    const type = info.rateLimitType ?? "unknown";

    if (info.status === "rejected") {
      // resetsAt is seconds since epoch in the SDK payload.
      const until = info.resetsAt ? info.resetsAt * 1000 : now + 15 * 60_000;
      const cooldown: Cooldown = { until, rateLimitType: info.rateLimitType ?? null, recordedAt: now };
      this.store.state.setJson(COOLDOWN_KEY, cooldown);
      this.log.error({ rateLimitType: type, until: new Date(until).toISOString() }, "subscription quota exhausted");
      this.events.onCooldown?.(
        cooldown,
        `Claude subscription quota is exhausted (\`${type}\`). It resets <t:${Math.floor(until / 1000)}:R>. ` +
          `I'll answer normally after that — no need to retry until then.`,
      );
      return;
    }

    const utilization = info.utilization;
    const previous = this.lastUtilization.get(type);
    if (utilization !== undefined) this.lastUtilization.set(type, utilization);

    // The window rolled: utilization dropped. Restore full concurrency and let
    // the next high-utilization report warn again.
    if (utilization !== undefined && previous !== undefined && utilization < previous) {
      this.store.state.delete(`${WARN_KEY_PREFIX}${type}`);
      if (this.semaphore.capacity < this.cfg.AGENT_MAX_CONCURRENT_RUNS) {
        this.semaphore.setLimit(this.cfg.AGENT_MAX_CONCURRENT_RUNS);
        this.log.info({ rateLimitType: type }, "quota window rolled — concurrency restored");
      }
    }

    const high =
      info.status === "allowed_warning" ||
      (utilization !== undefined && utilization >= this.cfg.QUOTA_WARN_UTILIZATION);

    if (!high) return;

    if (this.semaphore.capacity > 1) {
      this.semaphore.setLimit(1);
      this.log.warn({ rateLimitType: type, utilization }, "quota pressure — concurrency reduced to 1");
    }

    // One warning per type per window, so a busy hour doesn't spam the channel.
    const warnKey = `${WARN_KEY_PREFIX}${type}`;
    if (this.store.state.get(warnKey)) return;
    this.store.state.set(warnKey, String(now));

    const pct = utilization !== undefined ? `${Math.round(utilization * 100)}%` : "high";
    this.events.onWarning?.(
      info,
      `Subscription quota at ${pct} of the \`${type}\` window. Concurrency reduced to 1.`,
    );
  }

  cooldown(): Cooldown | null {
    return this.store.state.getJson<Cooldown>(COOLDOWN_KEY) ?? null;
  }

  clearCooldown(): void {
    if (!this.store.state.get(COOLDOWN_KEY)) return;
    this.store.state.delete(COOLDOWN_KEY);
    this.semaphore.setLimit(this.cfg.AGENT_MAX_CONCURRENT_RUNS);
    this.log.info("quota cooldown expired — resuming normal operation");
    this.events.onCooldownCleared?.();
  }

  status(now = Date.now()): QuotaStatus {
    const cd = this.cooldown();
    return {
      spentLastHour: this.store.turns.agentTurnsSince(now - 3_600_000),
      hourlyLimit: this.cfg.AGENT_TURNS_PER_HOUR,
      inFlight: this.semaphore.inUse,
      concurrencyLimit: this.semaphore.capacity,
      queued: this.semaphore.waiting,
      cooldown: cd && cd.until > now ? cd : null,
    };
  }
}

/** Operator-facing text for a refusal. Says explicitly that nothing was spent. */
export function explainVerdict(v: QuotaVerdict): string {
  if (v.allowed) return "";
  if (v.reason === "cooldown") {
    const type = v.rateLimitType ? `\`${v.rateLimitType}\`` : "the subscription";
    return (
      `Claude subscription quota is exhausted (${type}). It resets <t:${Math.floor(v.until / 1000)}:R>. ` +
      `Nothing was sent to the model.`
    );
  }
  return (
    `Turn budget for this hour is spent (${v.spent}/${v.limit}). It frees up gradually — ` +
    `try again <t:${Math.floor(v.retryAt / 1000)}:R>. Nothing was sent to the model.`
  );
}
