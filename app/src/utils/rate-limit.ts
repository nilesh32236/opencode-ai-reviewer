import { GitHubHelper, Logger, RateLimiter } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  GitHubEvent,
  LearningStore,
  RateLimitResult,
  RateLimitTier,
} from '@opencode-pr-agent/lib';
import { getToken } from './token.js';

const logger = new Logger('RateLimit');

/** Stable marker for the single 429-style denial notice per PR/issue. */
const RATE_LIMIT_MARKER = '<!-- rate-limit-reached -->';

/**
 * Minimum time between denial-notice posts for the same PR/issue. Repeated
 * blocked attempts within this window update nothing (the marker is already in
 * place), avoiding paginated comment-fetch + PATCH churn under burst traffic.
 */
const DENIAL_NOTICE_THROTTLE_MS = 10 * 60 * 1000;

/** Last posted denial-notice timestamp per `repo#prNumber`. */
const lastDenialNotice = new Map<string, number>();

/**
 * Clear the in-memory denial-notice throttle (used by tests).
 */
export function clearDenialNoticeThrottle(): void {
  lastDenialNotice.clear();
}

/**
 * Create a shared RateLimiter backed by the learning store and app config.
 * @param store - The learning store used for rate-limit persistence.
 * @param config - Resolved agent configuration.
 * @returns A RateLimiter instance.
 */
export function createRateLimiter(store: LearningStore, config: AgentConfig): RateLimiter {
  return new RateLimiter(config.rateLimiting, store);
}

/** Options for a rate limit check. */
export interface CheckRateLimitOptions {
  /** Optional PR/issue number override (defaults to event.prNumber). */
  prNumber?: number;
  /**
   * Whether to post a 429-style explanation comment when denied. Defaults to
   * true; set to false for auto-triggered events (e.g. pr.opened reviews)
   * where no user invoked the bot and a denial comment would be misleading.
   */
  postDenialComment?: boolean;
}

/**
 * Check whether an action is allowed under the configured rate limits. When
 * allowed, a rate-limit slot is reserved immediately so concurrent events are
 * counted before the expensive run begins. When denied, optionally posts a
 * single 429-style explanation comment (upserted via a stable marker) and
 * returns null so the caller skips the expensive work.
 * @param limiter - The RateLimiter (or null when rate limiting is unavailable).
 * @param event - The GitHub event being processed.
 * @param tier - Cost tier of the action ('command' or 'interactive').
 * @param action - Command name of the action.
 * @param options - Optional prNumber and comment-posting behavior.
 * @returns The rate limit result (carrying the reservation ID) when allowed,
 * or null when denied or rate limiting is unavailable.
 */
export async function checkRateLimit(
  limiter: RateLimiter | null,
  event: GitHubEvent,
  tier: RateLimitTier,
  action: string,
  options: CheckRateLimitOptions = {},
): Promise<RateLimitResult | null> {
  if (!limiter) {
    // Rate limiting unavailable: never block, and no reservation to reconcile.
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAt: Date.now() };
  }
  const repo = event.repo || '';
  const target = options.prNumber ?? event.prNumber ?? 0;
  if (!repo || !target) return null;
  const user = extractActor(event.payload);
  if (user === 'unknown') {
    logger.warn(
      `Could not attribute rate-limit action to a GitHub user (repo=${repo}, pr=${target}); charging 'unknown' bucket`,
    );
  }
  const result = await limiter.checkReview(repo, user, target, { tier, action });
  if (result.allowed) return result;
  if (options.postDenialComment !== false) {
    const noticeKey = `${repo}#${target}`;
    const now = Date.now();
    const lastPosted = lastDenialNotice.get(noticeKey) ?? 0;
    if (now - lastPosted >= DENIAL_NOTICE_THROTTLE_MS) {
      try {
        const gh = new GitHubHelper(getToken(), repo);
        await gh.postOrUpdateComment(target, RATE_LIMIT_MARKER, limiter.formatLimitMessage(result));
        lastDenialNotice.set(noticeKey, now);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to post rate limit message: ${msg}`);
      }
    }
  }
  return null;
}

/**
 * Record a completed action so it counts toward future rate limit checks.
 * Reconciles the reservation made by checkRateLimit with the actual token
 * usage when one exists; falls back to recording a fresh row otherwise.
 * @param limiter - The RateLimiter (or null when rate limiting is unavailable).
 * @param event - The GitHub event being processed.
 * @param tier - Cost tier of the action.
 * @param action - Command name of the action.
 * @param reservation - Optional result returned by checkRateLimit (carries the reservation ID).
 * @param tokensUsed - Optional actual token usage.
 */
export async function recordRateLimit(
  limiter: RateLimiter | null,
  event: GitHubEvent,
  tier: RateLimitTier,
  action: string,
  reservation?: RateLimitResult | null,
  tokensUsed?: number,
): Promise<void> {
  if (!limiter) return;
  const repo = event.repo || '';
  const prNumber = event.prNumber ?? 0;
  if (!repo || !prNumber) return;
  const user = extractActor(event.payload);
  await limiter.recordReview(
    repo,
    user,
    prNumber,
    action,
    tier,
    tokensUsed,
    reservation?.reservationId,
  );
}

/**
 * Extract the acting GitHub username from an event payload, preferring the
 * comment author, then the sender, then the PR/issue author.
 * @param payload - Raw event payload.
 * @returns A GitHub username, or 'unknown'.
 */
function extractActor(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const comment = p.comment as Record<string, unknown> | undefined;
  const sender = p.sender as Record<string, unknown> | undefined;
  const pullRequest = p.pull_request as Record<string, unknown> | undefined;
  const issue = p.issue as Record<string, unknown> | undefined;

  const loginOf = (obj: Record<string, unknown> | undefined): string | undefined => {
    const user = obj?.user as Record<string, unknown> | undefined;
    return typeof user?.login === 'string' ? (user.login as string) : undefined;
  };
  const senderLogin = typeof sender?.login === 'string' ? (sender.login as string) : undefined;

  return loginOf(comment) || senderLogin || loginOf(pullRequest) || loginOf(issue) || 'unknown';
}
