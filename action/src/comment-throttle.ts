import * as core from '@actions/core';
import * as github from '@actions/github';
import { resolveCommentAuthor } from '@opencode-pr-agent/lib';
import { extractCommentCommand, redactActor } from './comment-commands.js';
import { DEFAULT_COMMENT_THROTTLE_MS, parseCommentThrottleMs } from './inputs.js';

export { DEFAULT_COMMENT_THROTTLE_MS, parseCommentThrottleMs };

/**
 * Maximum authorized comment triggers per actor per rolling hour. A second,
 * coarser bound on top of the per-PR cooldown so fanning `/fix` across many
 * PRs cannot multiply LLM spend unboundedly.
 */
export const MAX_COMMENT_TRIGGERS_PER_HOUR = 20;

/** One hour in milliseconds (rolling window for the per-actor cap). */
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Last-trigger timestamp per `actor-tag:pr:command` key (cooldown). */
const lastTriggerByKey = new Map<string, number>();

/** Trigger timestamps per redacted actor tag (hourly cap). */
const triggerTimesByActor = new Map<string, number[]>();

/**
 * Reset in-process throttle state. Exported for tests; the production path
 * never calls it (each action run is a fresh process with empty state).
 */
export function resetCommentThrottle(): void {
  lastTriggerByKey.clear();
  triggerTimesByActor.clear();
}

/**
 * Stable throttle key for the current comment trigger, or null when the
 * payload names no author (fail-closed identity: no key, no throttle
 * decision — the caller already failed the permission gate in that case).
 * @returns The throttle key plus display fields, or null.
 */
function resolveThrottleKey(): { key: string; actorTag: string } | null {
  const actor = resolveCommentAuthor(github.context.payload, github.context.actor);
  if (!actor) return null;
  const comment = github.context.payload.comment as { body?: unknown } | undefined;
  const body = typeof comment?.body === 'string' ? comment.body : undefined;
  const review = github.context.payload.review as { body?: unknown } | undefined;
  const reviewBody = typeof review?.body === 'string' ? review.body : undefined;
  const command = extractCommentCommand(body ?? reviewBody ?? '') ?? 'unrecognized';
  const issueNumber =
    (github.context.payload.issue as { number?: unknown } | undefined)?.number ??
    (github.context.payload.pull_request as { number?: unknown } | undefined)?.number ??
    (github.context.payload.number as unknown);
  const prRef =
    typeof issueNumber === 'number' && Number.isInteger(issueNumber) ? String(issueNumber) : 'n/a';
  const actorTag = redactActor(actor);
  return { key: `${actorTag}:${prRef}:${command}`, actorTag };
}

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
export function checkAndRecordCommentTrigger(
  now: number = Date.now(),
  cooldownMs: number = parseCommentThrottleMs(core.getInput('comment_throttle_ms')),
): { throttled: boolean; reason?: string } {
  const resolved = resolveThrottleKey();
  if (!resolved) return { throttled: false };
  const { key, actorTag } = resolved;

  const last = lastTriggerByKey.get(key);
  if (last !== undefined && cooldownMs > 0 && now - last < cooldownMs) {
    const waitSec = Math.ceil((cooldownMs - (now - last)) / 1000);
    return {
      throttled: true,
      reason: `Ignoring duplicate comment trigger for ${key} (${waitSec}s of cooldown remaining)`,
    };
  }

  const windowStart = now - ONE_HOUR_MS;
  const recent = (triggerTimesByActor.get(actorTag) ?? []).filter((t) => t > windowStart);
  if (recent.length >= MAX_COMMENT_TRIGGERS_PER_HOUR) {
    return {
      throttled: true,
      reason: `Comment trigger rate limit exceeded for ${actorTag} (${recent.length}/${MAX_COMMENT_TRIGGERS_PER_HOUR} per hour) — try again later`,
    };
  }

  lastTriggerByKey.set(key, now);
  recent.push(now);
  triggerTimesByActor.set(actorTag, recent);
  return { throttled: false };
}
