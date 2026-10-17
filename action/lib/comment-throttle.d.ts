import { DEFAULT_COMMENT_THROTTLE_MS, parseCommentThrottleMs } from './inputs.js';
export { DEFAULT_COMMENT_THROTTLE_MS, parseCommentThrottleMs };
/**
 * Maximum authorized comment triggers per actor per rolling hour. A second,
 * coarser bound on top of the per-PR cooldown so fanning `/fix` across many
 * PRs cannot multiply LLM spend unboundedly.
 */
export declare const MAX_COMMENT_TRIGGERS_PER_HOUR = 20;
/**
 * Reset in-process throttle state. Exported for tests; the production path
 * never calls it (each action run is a fresh process with empty state).
 */
export declare function resetCommentThrottle(): void;
/**
 * Check the comment-trigger throttle and record the trigger when allowed.
 * Consult only AFTER the permission gate authorized the run: throttling an
 * unauthorized trigger would mask the fail-closed denial, and this function
 * returns "not throttled" (allow) whenever it cannot resolve a stable key.
 * @param now - Current timestamp (injectable for tests; defaults to Date.now()).
 * @param cooldownMs - Per-key cooldown (defaults to the parsed input/default).
 * @returns `{ throttled: true, reason }` when the run must stop before LLM
 * work, otherwise `{ throttled: false }` (and the trigger is recorded).
 */
export declare function checkAndRecordCommentTrigger(now?: number, cooldownMs?: number): {
    throttled: boolean;
    reason?: string;
};
