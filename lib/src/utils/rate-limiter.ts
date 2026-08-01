import type {
  RateLimitActionInput,
  RateLimitCountFilter,
  RateLimitReservationInput,
  RateLimitReservationResult,
} from '../learning/types.js';
import type { RateLimitTier, RateLimitingConfig } from '../types/index.js';
import { Logger } from './logger.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Reason a rate limit was hit. */
export type RateLimitReason =
  | 'repo_hourly'
  | 'user_daily'
  | 'pr_cooldown'
  | 'token_budget'
  | 'store_unavailable';

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
  reserveRateLimitSlot(input: RateLimitReservationInput): Promise<RateLimitReservationResult>;
  countRateLimitActions(filter: RateLimitCountFilter): Promise<number>;
  sumRateLimitTokens(sinceMs: number): Promise<number>;
  getLastRateLimitTime(repo: string, prNumber: number, tier: string): Promise<number | null>;
  recordRateLimitAction(input: RateLimitActionInput): Promise<string>;
  completeRateLimitAction(id: string, tokensUsed: number): Promise<void>;
  getRateLimitUsageByRepo(
    sinceMs: number,
    limit?: number,
    tier?: string,
  ): Promise<Array<{ repo: string; count: number }>>;
  getRateLimitUsageByUser(
    sinceMs: number,
    limit?: number,
  ): Promise<Array<{ user: string; count: number }>>;
  resetRateLimits(repo?: string, user?: string): Promise<number>;
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
 * To close the check-then-run race, checkReview() evaluates every limit and
 * reserves a rate_limits row (charged the tier estimate) in a single atomic
 * store operation, so concurrent webhook events observe each other's
 * reservations before the (potentially minutes-long) LLM run finishes.
 * recordReview() reconciles the reservation with actual token usage; when a run
 * fails or is skipped, the reservation is left in place so the attempt still
 * counts toward the limits. When the store is unavailable the check fails
 * closed (denies) so the cost-control guardrail cannot silently disappear.
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

    const input: RateLimitReservationInput = {
      repo,
      githubUser: user,
      prNumber,
      action: options?.action ?? 'review',
      tier,
      tokensUsed: estimatedTokens,
      now,
      hourStart,
      dayStart,
      hourMs: HOUR_MS,
      dayMs: DAY_MS,
      repoHourlyLimit: tier === 'command' ? this.config.reviewsPerRepoPerHour : null,
      userDailyLimit: this.config.reviewsPerUserPerDay,
      cooldownMs,
      tokenBudget: this.config.dailyTokenBudget,
    };

    let reservation: RateLimitReservationResult;
    try {
      // The repo/user/cooldown/token checks and the reservation insert run in a
      // single atomic store operation, so concurrent requests observe each
      // other's reservations before any (potentially minutes-long) LLM run
      // starts. When the store cannot measure usage or persist the reservation,
      // fail closed: deny rather than silently disabling the cost-control
      // guardrail.
      reservation = await this.store.reserveRateLimitSlot(input);
    } catch (err) {
      const logger = new Logger('RateLimiter');
      logger.error('Rate-limit store unavailable; failing closed (denying action)', err);
      return {
        allowed: false,
        reason: 'store_unavailable',
        remaining: 0,
        resetAt: dayStart + DAY_MS,
      };
    }

    if (!reservation.allowed) {
      return {
        allowed: false,
        reason: reservation.reason,
        remaining: 0,
        resetAt: reservation.resetAt,
      };
    }

    const { repoCount, userCount, tokensUsed } = reservation;
    // Post-reservation headroom: this request already reserved one slot, so the
    // remaining counts reflect the reservation. Guard against a zero tier
    // estimate (otherwise the division yields Infinity/NaN).
    const budgetHeadroomActions =
      estimatedTokens > 0
        ? Math.floor(Math.max(0, this.config.dailyTokenBudget - tokensUsed) / estimatedTokens)
        : Number.MAX_SAFE_INTEGER;
    const remaining =
      tier === 'command'
        ? Math.max(
            0,
            Math.min(
              this.config.reviewsPerRepoPerHour - repoCount,
              this.config.reviewsPerUserPerDay - userCount,
              budgetHeadroomActions,
            ),
          )
        : Math.max(
            0,
            Math.min(this.config.reviewsPerUserPerDay - userCount, budgetHeadroomActions),
          );

    // The soonest of the hourly and daily reset boundaries governs when the
    // tightest limit frees up.
    const resetAt = Math.min(hourStart + HOUR_MS, dayStart + DAY_MS);

    return { allowed: true, remaining, resetAt, reservationId: reservation.reservationId };
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
      store_unavailable: 'the rate-limit store is unavailable',
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

/** Get the epoch millisecond timestamp of the start of the current UTC day. */
function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Format an epoch millisecond timestamp as a readable UTC label. */
function formatResetTime(ts: number): string {
  return `${new Date(ts).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
