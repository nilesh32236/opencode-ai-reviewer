import type { RateLimitActionInput, RateLimitCountFilter } from '../learning/types.js';
import type { RateLimitTier, RateLimitingConfig } from '../types/index.js';
import { Logger } from './logger.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Reason a rate limit was hit. */
export type RateLimitReason = 'repo_hourly' | 'user_daily' | 'pr_cooldown' | 'token_budget';

/** Result of a rate limit check. */
export interface RateLimitResult {
  /** Whether the action may proceed. */
  allowed: boolean;
  /** Which limit was hit when allowed is false. */
  reason?: RateLimitReason;
  /** Remaining headroom (actions or tokens) when allowed; 0 when denied. */
  remaining: number;
  /** Epoch millisecond timestamp after which the limit resets. */
  resetAt: number;
  /**
   * ID of the rate_limits row reserved for this action when allowed.
   * The reservation is charged the tier estimate immediately so concurrent
   * requests are counted before execution begins; pass it to recordReview so
   * the actual token usage can be reconciled after the run.
   */
  reservationId?: string;
}

/** Options for a rate limit check. */
export interface RateLimitCheckOptions {
  /** Cost tier of the action. Defaults to 'command'. */
  tier?: RateLimitTier;
  /** Command name for the action (used when recording). */
  action?: string;
}

/** Persistence contract implemented by the learning store. */
export interface RateLimitStore {
  /**
   * Count rate-limit rows matching a filter.
   * @param filter - Filter with optional repo/user/tier and required sinceMs cutoff.
   * @returns The number of matching rows.
   */
  countRateLimitActions(filter: RateLimitCountFilter): Promise<number>;
  /**
   * Sum the tokens_used of all rate-limit rows at or after sinceMs.
   * @param sinceMs - Window cutoff as an epoch millisecond timestamp.
   * @returns Total estimated tokens consumed in the window.
   */
  sumRateLimitTokens(sinceMs: number): Promise<number>;
  /**
   * Get the most recent rate-limit action time for a repo, PR, and tier.
   * @param repo - Repository in owner/repo format.
   * @param prNumber - PR number to look up.
   * @param tier - Tier ('command' or 'interactive').
   * @returns Epoch millisecond timestamp of the last action, or null if none.
   */
  getLastRateLimitTime(repo: string, prNumber: number, tier: string): Promise<number | null>;
  /**
   * Record a rate-limited action.
   * @param input - Rate limit action data to append.
   * @returns The generated row ID, for later token reconciliation.
   */
  recordRateLimitAction(input: RateLimitActionInput): Promise<string>;
  /**
   * Reconcile a reserved rate-limit row with its actual token usage.
   * @param id - Row ID returned by recordRateLimitAction.
   * @param tokensUsed - Actual tokens consumed by the run.
   * @returns A promise that resolves when the reconciliation is complete.
   */
  completeRateLimitAction(id: string, tokensUsed: number): Promise<void>;
  /**
   * Aggregate rate-limit usage counts grouped by repository.
   * @param sinceMs - Window cutoff as an epoch millisecond timestamp.
   * @param limit - Maximum number of results (default: 10).
   * @param tier - Optional tier filter.
   * @returns Array of repo/count pairs ordered by count descending.
   */
  getRateLimitUsageByRepo(
    sinceMs: number,
    limit?: number,
    tier?: string,
  ): Promise<Array<{ repo: string; count: number }>>;
  /**
   * Aggregate rate-limit usage counts grouped by user.
   * @param sinceMs - Window cutoff as an epoch millisecond timestamp.
   * @param limit - Maximum number of results (default: 10).
   * @returns Array of user/count pairs ordered by count descending.
   */
  getRateLimitUsageByUser(
    sinceMs: number,
    limit?: number,
  ): Promise<Array<{ user: string; count: number }>>;
  /**
   * Reset rate-limit records for a repo and/or user.
   * @param repo - Optional repository in owner/repo format to scope the reset.
   * @param user - Optional GitHub username to scope the reset.
   * @returns Number of deleted records.
   */
  resetRateLimits(repo?: string, user?: string): Promise<number>;
  /**
   * Delete rate-limit records older than the given cutoff.
   * @param olderThanMs - Epoch millisecond cutoff; older rows are deleted.
   * @returns Number of deleted records.
   */
  cleanupRateLimits(olderThanMs: number): Promise<number>;
}

/** Current rate limit usage for the admin `/rate-limits` command. */
export interface RateLimitStatus {
  /** Per-repository hourly usage for command-tier actions. */
  repoHourly: Array<{ repo: string; count: number; limit: number }>;
  /** Per-user daily usage across all tiers. */
  userDaily: Array<{ user: string; count: number; limit: number }>;
  /** Estimated tokens consumed today. */
  tokenUsageToday: number;
  /** Configured daily token budget. */
  tokenBudget: number;
}

/**
 * Enforce rate limits for Probot slash commands, @mention conversations, and
 * threaded replies. Limits are persisted in the learning store so they survive
 * app restarts:
 * - Per-repo hourly cap (command tier only).
 * - Per-user daily cap (all tiers combined).
 * - Per-PR cooldown (separate for command and interactive tiers).
 * - Daily estimated token budget (all tiers combined).
 *
 * To close the check-then-run race, checkReview() reserves a rate_limits row
 * (charged the tier estimate) immediately after all checks pass, so concurrent
 * webhook events see the reservation before the (potentially minutes-long) LLM
 * run finishes. recordReview() reconciles the reservation with actual token
 * usage; when a run fails or is skipped, the reservation is left in place so
 * the attempt still counts toward the limits.
 */
export class RateLimiter {
  private readonly config: RateLimitingConfig;
  private readonly store: RateLimitStore;

  /**
   * @param config - Rate limiting configuration.
   * @param store - Persistence store for rate limit state.
   */
  constructor(config: RateLimitingConfig, store: RateLimitStore) {
    this.config = config;
    this.store = store;
  }

  /**
   * Check whether an action is allowed under all configured limits. When
   * allowed, reserves a rate_limits row so the action counts immediately.
   * @param repo - Repository in owner/repo format.
   * @param user - GitHub username of the actor.
   * @param prNumber - PR (or issue) number the action targets.
   * @param options - Optional tier and action name.
   * @returns A RateLimitResult describing whether the action may proceed.
   */
  async checkReview(
    repo: string,
    user: string,
    prNumber: number,
    options?: RateLimitCheckOptions,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const tier = options?.tier ?? 'command';
    if (!this.config.enabled) {
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAt: now };
    }

    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    const dayStart = startOfUtcDay(now);
    const cooldownMs =
      tier === 'interactive'
        ? this.config.conversationCooldownSeconds * 1000
        : this.config.prCooldownMinutes * 60 * 1000;
    const estimatedTokens =
      tier === 'interactive'
        ? this.config.estimatedTokensPerInteractive
        : this.config.estimatedTokensPerCommand;

    let repoCount = 0;
    if (tier === 'command') {
      repoCount = await this.store.countRateLimitActions({
        repo,
        tier: 'command',
        sinceMs: hourStart,
      });
      if (repoCount >= this.config.reviewsPerRepoPerHour) {
        return {
          allowed: false,
          reason: 'repo_hourly',
          remaining: 0,
          resetAt: hourStart + HOUR_MS,
        };
      }
    }

    const userCount = await this.store.countRateLimitActions({
      user,
      sinceMs: dayStart,
    });
    if (userCount >= this.config.reviewsPerUserPerDay) {
      return {
        allowed: false,
        reason: 'user_daily',
        remaining: 0,
        resetAt: dayStart + DAY_MS,
      };
    }

    const lastTime = await this.store.getLastRateLimitTime(repo, prNumber, tier);
    if (lastTime !== null && now - lastTime < cooldownMs) {
      return {
        allowed: false,
        reason: 'pr_cooldown',
        remaining: 0,
        resetAt: lastTime + cooldownMs,
      };
    }

    const tokensUsed = await this.store.sumRateLimitTokens(dayStart);
    if (tokensUsed + estimatedTokens > this.config.dailyTokenBudget) {
      return {
        allowed: false,
        reason: 'token_budget',
        remaining: Math.max(0, this.config.dailyTokenBudget - tokensUsed),
        resetAt: dayStart + DAY_MS,
      };
    }

    let reservationId: string | undefined;
    try {
      reservationId = await this.store.recordRateLimitAction({
        repo,
        githubUser: user,
        prNumber,
        action: options?.action ?? 'review',
        tier,
        tokensUsed: estimatedTokens,
      });
    } catch (err) {
      const logger = new Logger('RateLimiter');
      logger.error('Failed to reserve rate limit slot; proceeding without reservation', err);
    }

    const budgetHeadroomActions = Math.floor(
      Math.max(0, this.config.dailyTokenBudget - tokensUsed) / estimatedTokens,
    );
    const remaining =
      tier === 'command'
        ? Math.min(
            this.config.reviewsPerRepoPerHour - repoCount,
            this.config.reviewsPerUserPerDay - userCount,
            budgetHeadroomActions,
          )
        : Math.min(this.config.reviewsPerUserPerDay - userCount, budgetHeadroomActions);

    return { allowed: true, remaining, resetAt: dayStart + DAY_MS, reservationId };
  }

  /**
   * Record a completed action so it counts toward future checks. When called
   * with a reservationId (from checkReview), reconciles that row's token charge
   * with the actual usage; otherwise falls back to recording a new row.
   * @param repo - Repository in owner/repo format.
   * @param user - GitHub username of the actor.
   * @param prNumber - PR (or issue) number the action targeted.
   * @param action - Command name that ran (e.g. 'review', 'conversation').
   * @param tier - Cost tier of the action.
   * @param tokensUsed - Optional actual token usage; falls back to the tier estimate.
   * @param reservationId - Optional reservation row ID from checkReview.
   */
  async recordReview(
    repo: string,
    user: string,
    prNumber: number,
    action: string,
    tier: RateLimitTier,
    tokensUsed?: number,
    reservationId?: string,
  ): Promise<void> {
    if (!this.config.enabled) return;
    const estimate =
      tier === 'interactive'
        ? this.config.estimatedTokensPerInteractive
        : this.config.estimatedTokensPerCommand;
    const resolvedTokens = tokensUsed ?? estimate;
    if (reservationId) {
      await this.store.completeRateLimitAction(reservationId, resolvedTokens);
      return;
    }
    await this.store.recordRateLimitAction({
      repo,
      githubUser: user,
      prNumber,
      action,
      tier,
      tokensUsed: resolvedTokens,
    });
  }

  /**
   * Build a user-facing message explaining a denied action and when it resets.
   * @param result - A denied RateLimitResult.
   * @returns A markdown message, or an empty string when the result was allowed.
   */
  formatLimitMessage(result: RateLimitResult): string {
    if (result.allowed) return '';
    const reasons: Record<RateLimitReason, string> = {
      repo_hourly: 'the per-repository hourly review limit',
      user_daily: 'the per-user daily review limit',
      pr_cooldown: 'the cooldown between actions on the same pull request',
      token_budget: 'the daily token budget',
    };
    const reasonText = result.reason ? reasons[result.reason] : 'the rate limit';
    return [
      '## ⏳ Rate Limit Reached',
      `This action was **not** run because ${reasonText} has been reached.`,
      `**Try again after:** \`${formatResetTime(result.resetAt)}\``,
    ].join('\n\n');
  }

  /**
   * Aggregate current usage for the admin `/rate-limits` command.
   * @returns A RateLimitStatus with per-repo, per-user, and token usage.
   */
  async getStatus(): Promise<RateLimitStatus> {
    const now = Date.now();
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    const dayStart = startOfUtcDay(now);
    const [repoHourly, userDaily, tokenUsageToday] = await Promise.all([
      this.store.getRateLimitUsageByRepo(hourStart, 10, 'command'),
      this.store.getRateLimitUsageByUser(dayStart, 10),
      this.store.sumRateLimitTokens(dayStart),
    ]);
    return {
      repoHourly: repoHourly.map((r) => ({
        repo: r.repo,
        count: r.count,
        limit: this.config.reviewsPerRepoPerHour,
      })),
      userDaily: userDaily.map((u) => ({
        user: u.user,
        count: u.count,
        limit: this.config.reviewsPerUserPerDay,
      })),
      tokenUsageToday,
      tokenBudget: this.config.dailyTokenBudget,
    };
  }

  /**
   * Reset all rate-limit records for a repository.
   * @param repo - Repository in owner/repo format.
   * @returns Number of deleted records.
   */
  async resetRepo(repo: string): Promise<number> {
    return this.store.resetRateLimits(repo);
  }

  /**
   * Reset all rate-limit records for a GitHub user.
   * @param user - GitHub username.
   * @returns Number of deleted records.
   */
  async resetUser(user: string): Promise<number> {
    return this.store.resetRateLimits(undefined, user);
  }

  /**
   * Reset all rate-limit records.
   * @returns Number of deleted records.
   */
  async resetAll(): Promise<number> {
    return this.store.resetRateLimits();
  }

  /**
   * Prune rate-limit records older than the configured retention window.
   * @returns Number of deleted records.
   */
  async cleanup(): Promise<number> {
    const cutoff = Date.now() - this.config.retentionHours * HOUR_MS;
    return this.store.cleanupRateLimits(cutoff);
  }
}

/**
 * Get the epoch millisecond timestamp of the start of the current UTC day.
 * @param ts - Epoch millisecond timestamp to convert.
 * @returns Epoch millisecond timestamp of the start of the UTC day.
 */
function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Format an epoch millisecond timestamp as a readable UTC label.
 * @param ts - Epoch millisecond timestamp to format.
 * @returns Readable UTC timestamp label.
 */
function formatResetTime(ts: number): string {
  return `${new Date(ts).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
