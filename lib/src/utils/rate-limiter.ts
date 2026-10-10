import type { RateLimitActionInput, RateLimitCountFilter } from '../learning/types.js';
import type { RateLimitTier, RateLimitingConfig } from '../types/index.js';
import { Logger } from './logger.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Minimal in-process FIFO mutex with bounded queue wait.
 *
 * Serializes the read-check-reserve critical section in `checkReview()` so
 * concurrent webhook deliveries cannot all read the same pre-insert counts,
 * all pass the gate, and all insert (TOCTOU overshoot of `limit +
 * (concurrency - 1)`). The chain is FIFO: each waiter inherits the tail and
 * the previous tail settles before the next critical section starts, and a
 * throwing critical section still releases via `finally` so the chain never
 * stalls.
 *
 * The queue wait is BOUNDED: a waiter that cannot acquire the mutex within
 * `timeoutMs` fails fast (its chain link is left in place until the current
 * holder settles, so FIFO mutual exclusion is preserved for the remaining
 * waiters), so a hung store query holding the critical section cannot
 * head-of-line block every repo/user behind it forever. The throw propagates
 * out of `checkReview()`, where it is denied fail-closed like a store outage.
 * Waits longer than `warnAfterMs` are reported via `onSlowWait` with the
 * current queue depth so p99 latency regressions are observable via
 * `getQueueDepth()` before the timeout fires.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  /**
   * Run `fn` with exclusive ownership of the mutex.
   * @param fn - Critical section to execute exclusively.
   * @param timeoutMs - Max queue wait before throwing (default: 30_000).
   * @param warnAfterMs - Queue wait beyond which a warning is logged (default: 1_000).
   * @param onSlowWait - Optional hook receiving (waitMs, queueDepth) for metrics.
   * @returns The critical section's result.
   */
  async runExclusive<T>(
    fn: () => Promise<T>,
    timeoutMs = 30_000,
    warnAfterMs = 1_000,
    onSlowWait?: (waitMs: number, queueDepth: number) => void,
  ): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = current;
    const queueDepth = ++this.pending;
    const enqueuedAt = Date.now();
    const done = (): void => {
      this.pending = Math.max(0, this.pending - 1);
      release();
    };
    // Phase 1: bounded queue wait — fail fast instead of head-of-line
    // blocking every repo/user behind a hung holder forever.
    if (timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          prev,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Rate-limit mutex wait timed out after ${timeoutMs}ms (queue depth ${queueDepth})`,
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } catch (waitErr) {
        // Do NOT release our chain link here: later waiters are chained
        // behind `current`, and releasing now would let them skip past the
        // still-holding predecessor and break mutual exclusion. Instead the
        // link resolves when the predecessor settles, preserving FIFO order
        // for everyone still waiting, while this caller fails fast.
        prev.then(done, done);
        throw waitErr;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } else {
      await prev;
    }
    const waitMs = Date.now() - enqueuedAt;
    if (waitMs > warnAfterMs) {
      onSlowWait?.(waitMs, queueDepth);
    }
    // Phase 2: run the critical section with guaranteed release.
    try {
      return await fn();
    } finally {
      done();
    }
  }

  /**
   * Get the number of waiters currently queued or holding the mutex.
   * @returns Current queue depth (observability only).
   */
  getQueueDepth(): number {
    return this.pending;
  }
}

/**
 * Module-scoped mutex shared by every `RateLimiter` instance in this process,
 * so concurrent deliveries through different instances still serialize. The
 * lock is process-local: it closes the single-process Action/Probot race
 * (the real deployment shape — reads are milliseconds of SQLite/JSON I/O, so
 * serializing the whole check costs negligible throughput). Cross-process
 * deployments sharing one store would additionally need a store-level atomic
 * reserve; until then a reservation-write failure degrades loudly via the
 * existing fail-closed / `degraded` paths rather than silently overshooting.
 */
const rateLimitCheckMutex = new AsyncMutex();

/** Max time a checkReview() waits to acquire the process-local mutex before failing fast (fail-closed). */
const RATE_LIMIT_MUTEX_TIMEOUT_MS = 30_000;
/** Mutex queue wait beyond which a slow-wait warning is logged with queue depth. */
const RATE_LIMIT_MUTEX_SLOW_WAIT_MS = 1_000;

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
  /**
   * True when the reservation write failed and the result was returned
   * without a reservation (fail-open). Concurrent requests during a store
   * degradation window can overshoot limits; operators should alert on this.
   */
  degraded?: boolean;
}

/** Options for a rate limit check. */
export interface RateLimitCheckOptions {
  /** Cost tier of the action. Defaults to 'command'. */
  tier?: RateLimitTier;
  /** Command name for the action (used when recording). */
  action?: string;
  /**
   * Per-call opt-in to fail-open when the reservation write fails.
   * Overrides `failClosedOnReservationError` for this check only.
   */
  failOpen?: boolean;
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
  private readonly logger = new Logger('RateLimiter');

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

    // The reads, the deny checks, and the reservation INSERT below run
    // inside a process-local FIFO mutex so the reservation is the gate:
    // concurrent deliveries serialize here, each seeing the previous
    // delivery's reservation before deciding allow/deny. Without this, N
    // concurrent checks all read the same pre-insert counts, all pass, and
    // all insert — overshooting the caps by (concurrency - 1). The mutex
    // wait is bounded (30s default): on timeout the check throws and the
    // caller denies fail-closed, so a hung holder cannot stall every
    // repo/user behind it; slow waits (>1s) are warned with queue depth.
    return rateLimitCheckMutex.runExclusive(
      async () => {
        // Fire the independent store reads concurrently (repo/user counts,
        // last-action time, token sum share the same windows but separate queries).
        // Limit checks below still apply in the original priority order
        // (repo_hourly → user_daily → pr_cooldown → token_budget) against the
        // resolved values, so allow/deny semantics are unchanged. allSettled is
        // used so an earlier-priority deny still wins when a later read fails;
        // a store error is only thrown when no deny applies.
        const [repoRes, userRes, lastRes, tokenRes] = await Promise.allSettled([
          tier === 'command'
            ? this.store.countRateLimitActions({ repo, tier: 'command', sinceMs: hourStart })
            : Promise.resolve(0),
          this.store.countRateLimitActions({ user, sinceMs: dayStart }),
          this.store.getLastRateLimitTime(repo, prNumber, tier),
          this.store.sumRateLimitTokens(dayStart),
        ]);

        const firstRejection = [repoRes, userRes, lastRes, tokenRes].find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        )?.reason;

        if (
          tier === 'command' &&
          repoRes.status === 'fulfilled' &&
          repoRes.value >= this.config.reviewsPerRepoPerHour
        ) {
          return {
            allowed: false,
            reason: 'repo_hourly',
            remaining: 0,
            resetAt: hourStart + HOUR_MS,
          };
        }

        if (userRes.status === 'fulfilled' && userRes.value >= this.config.reviewsPerUserPerDay) {
          return {
            allowed: false,
            reason: 'user_daily',
            remaining: 0,
            resetAt: dayStart + DAY_MS,
          };
        }

        if (
          lastRes.status === 'fulfilled' &&
          lastRes.value !== null &&
          now - lastRes.value < cooldownMs
        ) {
          return {
            allowed: false,
            reason: 'pr_cooldown',
            remaining: 0,
            resetAt: lastRes.value + cooldownMs,
          };
        }

        if (
          tokenRes.status === 'fulfilled' &&
          tokenRes.value + estimatedTokens > this.config.dailyTokenBudget
        ) {
          return {
            allowed: false,
            reason: 'token_budget',
            remaining: Math.max(0, this.config.dailyTokenBudget - tokenRes.value),
            resetAt: dayStart + DAY_MS,
          };
        }
        // No deny applies: surface the first store failure (if any) so DB errors
        // are never silently treated as "allowed".
        if (firstRejection !== undefined) throw firstRejection;
        const repoCount = (repoRes as PromiseFulfilledResult<number>).value;
        const userCount = (userRes as PromiseFulfilledResult<number>).value;
        const tokensUsed = (tokenRes as PromiseFulfilledResult<number>).value;

        let reservationId: string | undefined;
        let degraded = false;
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
          // Fail-closed by default (config.failClosedOnReservationError !== false):
          // deny the action so a DB outage cannot silently disable rate limiting
          // and overshoot token spend. Opt in to fail-open via config or
          // per-call `failOpen: true`; the degraded path always logs loudly so
          // operators can alert on it.
          const failClosed =
            options?.failOpen === true
              ? false
              : options?.failOpen === false
                ? true
                : this.config.failClosedOnReservationError !== false;
          if (failClosed) {
            this.logger.error(
              'Failed to reserve rate limit slot; denying action (fail-closed, store unavailable)',
              err,
            );
            throw err;
          }
          this.logger.error(
            'Failed to reserve rate limit slot; proceeding without reservation (degraded, limits may overshoot)',
            err,
          );
          degraded = true;
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

        return {
          allowed: true,
          remaining,
          resetAt: dayStart + DAY_MS,
          reservationId,
          ...(degraded ? { degraded: true as const } : {}),
        };
      },
      RATE_LIMIT_MUTEX_TIMEOUT_MS,
      RATE_LIMIT_MUTEX_SLOW_WAIT_MS,
      (waitMs, queueDepth) => {
        this.logger.warn(
          `Rate-limit mutex queue wait ${waitMs}ms exceeds 1s (queue depth ${queueDepth}); ` +
            `check throughput may be regressing — see getQueueDepth()`,
        );
      },
    );
  }

  /**
   * Record a completed action so it counts toward future checks. When called
   * with a reservationId (from checkReview), reconciles that row's token charge
   * with the actual usage; otherwise falls back to recording a new row.
   * Post-action bookkeeping is best-effort: a store outage here is logged and
   * swallowed (not thrown) so conversation/command handlers degrade gracefully
   * instead of crashing after the action already ran. Fail-closed denial only
   * applies to the `checkReview` reservation path, not this one.
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
      try {
        await this.store.completeRateLimitAction(reservationId, resolvedTokens);
      } catch (err) {
        this.logger.warn('Failed to complete rate-limit action', err);
      }
      return;
    }
    try {
      await this.store.recordRateLimitAction({
        repo,
        githubUser: user,
        prNumber,
        action,
        tier,
        tokensUsed: resolvedTokens,
      });
    } catch (err) {
      this.logger.warn('Failed to record rate-limit action', err);
    }
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
