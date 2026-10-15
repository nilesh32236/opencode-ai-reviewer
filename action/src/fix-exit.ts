/**
 * Shared fix exit-reason bridge between the main fix step and the post step.
 *
 * Dependency-free by design: both `fix.ts` (which pulls the engine/exec
 * chain) and `post.ts` (which must stay light for the post bundle) import
 * from here, so the state-key string and the mutated-tree predicate cannot
 * drift one-sided at runtime. Covered by the fix-exit-reason sync test.
 */

/**
 * State key written by the main fix step (`core.saveState` in fix.ts) and
 * exposed to the post process as `STATE_fix_exit_reason`.
 */
export const FIX_EXIT_REASON_STATE_KEY = 'fix_exit_reason';

/**
 * True when a fix exit reason means no clean fix landed, so verification
 * would measure the agent's mutated working tree rather than the base branch
 * or PR head (issue #942). Such runs must skip `run_checks_after_fix`.
 *
 * Known reason vocabulary: 'success', 'no-changes', 'git-failure',
 * 'verification-failed', 'exhausted', 'cancelled', 'context-failure',
 * 'pr-closed', 'deferred'. Only 'no-changes'/'git-failure' are mutated-tree
 * reasons.
 * @param reason - Fix exit reason from `core.getState`, when any.
 * @returns True for 'no-changes' and 'git-failure' (case-insensitive).
 */
export function isMutatedTreeExitReason(reason: string | undefined | null): boolean {
  if (!reason) return false;
  const normalized = reason.trim().toLowerCase();
  return normalized === 'no-changes' || normalized === 'git-failure';
}

/**
 * Post-side alias for {@link isMutatedTreeExitReason}.
 * Kept as a named export so `post.ts` call sites keep their intention-
 * revealing name while delegating to the single canonical predicate.
 * @param reason - Fix exit reason from `core.getState`, when any.
 * @returns True for 'no-changes' and 'git-failure' (case-insensitive).
 */
export function shouldSkipPostVerification(reason: string | undefined | null): boolean {
  return isMutatedTreeExitReason(reason);
}
