/**
 * The text a turn delivers to Discord.
 *
 * The SDK's `result` is only the text after the turn's last tool call. A turn
 * that writes its answer, then calls a tool — a poll, a log write — and closes
 * with one line would otherwise be delivered as that one line: the morning
 * brief arrived as "The soreness poll is under this message" with the
 * readiness call, the session and the lift all gone. So every text block the
 * agent wrote is kept, in order.
 */
export function answerText(blocks: readonly string[], result: string): string {
  const joined = blocks
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .join("\n\n");
  return joined.length > 0 ? joined : result;
}
