/**
 * Keeps Discord's "Bot is typing…" indicator alive for the length of a turn.
 *
 * The gap this fills: a turn that starts immediately produced no acknowledgement
 * at all until the first tokens arrived, which for a diagnosis can be tens of
 * seconds of silence. The 👀 reaction only appears when a message is *queued*
 * behind another turn — so the common case, where the bot got straight to work,
 * was the one that looked ignored.
 *
 * Discord expires a typing indicator after roughly 10 seconds, so it has to be
 * re-sent. The refresh interval is deliberately under that: a gap between
 * expiry and refresh makes the indicator flicker, which reads as worse than no
 * indicator at all.
 */

/** Just enough of a discord.js channel to be testable without a gateway. */
export interface Typeable {
  sendTyping(): Promise<unknown>;
}

export interface TypingOptions {
  /** How often to re-assert. Must stay below Discord's ~10s expiry. */
  readonly intervalMs?: number;
  /**
   * Hard stop, however long the turn runs.
   *
   * A safety net rather than a policy: agent turns have their own timeouts, so
   * reaching this means something failed to call stop(), and typing forever
   * would misreport a dead turn as an active one.
   */
  readonly maxMs?: number;
  readonly onError?: (e: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 8_000;
const DEFAULT_MAX_MS = 15 * 60_000;

/**
 * Starts typing and returns a stop function.
 *
 * Fire-and-forget by design: the first `sendTyping` is not awaited, because a
 * slow Discord API call must not delay the actual work. Failures are reported
 * and otherwise ignored — a missing typing indicator is cosmetic, and letting
 * it reject would take down a turn that was going to succeed.
 */
export function startTyping(channel: Typeable, opts: TypingOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;

  let stopped = false;
  const send = (): void => {
    if (stopped) return;
    void Promise.resolve(channel.sendTyping()).catch((e: unknown) => opts.onError?.(e));
  };

  send();

  const timer = setInterval(send, intervalMs);
  const deadline = setTimeout(() => stop(), maxMs);
  // Neither timer should hold the process open on shutdown.
  timer.unref?.();
  deadline.unref?.();

  // Idempotent: callers stop from a `finally`, and some paths can reach it
  // twice. A second call must not clear a timer belonging to a later turn.
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadline);
  }

  return stop;
}
