import { GitHubHelper, Logger, RateLimiter } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  GitHubEvent,
  LearningStore,
  RateLimitTier,
} from '@opencode-pr-agent/lib';
import { getToken } from './token.js';

const logger = new Logger('RateLimit');

/**
 * Create a shared RateLimiter backed by the learning store and app config.
 * @param store - The learning store used for rate-limit persistence.
 * @param config - Resolved agent configuration.
 * @returns A RateLimiter instance.
 */
export function createRateLimiter(store: LearningStore, config: AgentConfig): RateLimiter {
  return new RateLimiter(config.rateLimiting, store);
}

/**
 * Check whether an action is allowed under the configured rate limits.
 * When denied, posts a 429-style explanation comment on the PR/issue and
 * returns false so the caller skips the expensive work.
 * @param limiter - The RateLimiter (or null when rate limiting is unavailable).
 * @param event - The GitHub event being processed.
 * @param tier - Cost tier of the action ('command' or 'interactive').
 * @param action - Command name of the action.
 * @param prNumber - Optional PR/issue number override (defaults to event.prNumber).
 * @returns True when the action may proceed.
 */
export async function checkRateLimit(
  limiter: RateLimiter | null,
  event: GitHubEvent,
  tier: RateLimitTier,
  action: string,
  prNumber?: number,
): Promise<boolean> {
  if (!limiter) return true;
  const repo = event.repo || '';
  const target = prNumber ?? event.prNumber ?? 0;
  if (!repo || !target) return true;
  const user = extractActor(event.payload);
  const result = await limiter.checkReview(repo, user, target, { tier, action });
  if (result.allowed) return true;
  try {
    const gh = new GitHubHelper(getToken(), repo);
    await gh.postComment(target, limiter.formatLimitMessage(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to post rate limit message: ${msg}`);
  }
  return false;
}

/**
 * Record a completed action so it counts toward future rate limit checks.
 * @param limiter - The RateLimiter (or null when rate limiting is unavailable).
 * @param event - The GitHub event being processed.
 * @param tier - Cost tier of the action.
 * @param action - Command name of the action.
 * @param tokensUsed - Optional actual token usage.
 */
export async function recordRateLimit(
  limiter: RateLimiter | null,
  event: GitHubEvent,
  tier: RateLimitTier,
  action: string,
  tokensUsed?: number,
): Promise<void> {
  if (!limiter) return;
  const repo = event.repo || '';
  const prNumber = event.prNumber ?? 0;
  if (!repo || !prNumber) return;
  const user = extractActor(event.payload);
  await limiter.recordReview(repo, user, prNumber, action, tier, tokensUsed);
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
