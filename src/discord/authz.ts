/**
 * Who may cause an agent turn.
 *
 * This gates spend against the operator's personal Claude subscription, so it
 * fails closed: an empty allowlist authorises nobody rather than everybody.
 *
 * Deliberately separate from the approver allowlist. Approvers authorise
 * *writes*; chat roles authorise *turns*. Conflating them would mean anyone who
 * can ask a question can later approve a remediation.
 */

export interface ActorIdentity {
  readonly userId: string;
  readonly roleIds: readonly string[];
}

export interface AuthzConfig {
  readonly userIds: readonly string[];
  readonly roleIds: readonly string[];
}

export type AuthzResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function checkActor(cfg: AuthzConfig, actor: ActorIdentity): AuthzResult {
  if (cfg.userIds.length === 0 && cfg.roleIds.length === 0) {
    return {
      allowed: false,
      reason:
        "no chat allowlist is configured — set DISCORD_CHAT_ROLE_IDS or DISCORD_CHAT_USER_IDS",
    };
  }
  if (cfg.userIds.includes(actor.userId)) return { allowed: true };
  if (actor.roleIds.some((r) => cfg.roleIds.includes(r))) return { allowed: true };
  return { allowed: false, reason: "not authorised to use this bot" };
}
