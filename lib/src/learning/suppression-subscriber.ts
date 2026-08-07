import type { AgentConfig, GitHubEvent, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import type { LearningStore } from './store.js';

const DEBOUNCE_MS = 60_000;

/**
 * Default suppression-rule thresholds, applied when the supplied config does
 * not carry a `learning.suppressionRules` block.
 */
const DEFAULT_THRESHOLDS = {
  enabled: true,
  minDismissals: 3,
  ttlDays: 30,
  maxReviews: 20,
  maxRules: 25,
  excludeSeverities: ['critical'],
};

/**
 * Closes the dismissal-feedback learning loop. Listens to the same dismissal /
 * dispute events that the FeedbackSubscriber records, and periodically
 * translates high-confidence dismissal patterns into persisted suppression
 * rules that are later injected into review prompts (see
 * `getFalsePositiveRules`). Also sweeps expired rules so stale suppressions
 * are removed automatically.
 *
 * Generation and expiry are debounced per-PR and run off the review hot path,
 * mirroring FeedbackSubscriber's design. The event bus dispatches subscribers
 * concurrently, so the feedback a dismissal event triggers may not be visible
 * to the immediate sweep; a trailing sweep is therefore scheduled after every
 * sweep and runs once the debounce window has been quiet, reconciling any
 * feedback persisted in the meantime. Failures degrade gracefully: the review
 * flow never depends on this subscriber succeeding.
 */
export class SuppressionSubscriber implements Subscriber {
  name = 'SuppressionSubscriber';
  subscribedEvents = [
    'review.dismissed',
    'review_comment.dismissed',
    'review_comment.deleted',
    'comment.created',
    'review_comment.created',
    'review.completed',
  ];

  private readonly logger = new Logger('SuppressionSubscriber');
  private readonly lastProcessedAt = new Map<number, number>();
  private readonly timers = new Map<number, NodeJS.Timeout>();

  /**
   * @param store - The learning store used to generate and expire rules.
   * @param config - Agent config providing the suppression-rule thresholds.
   * @param debounceMs - Minimum interval between processing events per PR.
   */
  constructor(
    private readonly store: LearningStore,
    private readonly config: AgentConfig,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  /**
   * Generate and expire suppression rules when a dismissal/dispute feedback
   * event (or a completed review) arrives. Debounced per-PR so bursts of
   * related events produce at most one store sweep per window; every handled
   * event also schedules a single trailing sweep after the window to catch
   * feedback that the immediate sweep may have raced against.
   * @param event - The GitHub webhook event data.
   * @param signal - Optional abort signal to cancel handling.
   */
  async handle(event: GitHubEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    try {
      const prNumber = event.prNumber ?? 0;
      const now = Date.now();
      const lastProcessed = this.lastProcessedAt.get(prNumber);
      if (lastProcessed !== undefined && now - lastProcessed < this.debounceMs) {
        this.scheduleTrailingSweep(prNumber, signal);
        return;
      }
      this.lastProcessedAt.set(prNumber, now);
      try {
        await this.runSweep();
      } finally {
        // Always arm the reconciliation sweep, even when the immediate sweep
        // fails, so accumulated dismissals are re-evaluated once quiet.
        this.scheduleTrailingSweep(prNumber, signal);
      }
    } catch (err) {
      this.logger.warn(
        `Suppression rule sweep failed for PR #${event.prNumber} (event: ${event.type}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Schedule a single trailing sweep for a PR. Repeated in-window events
   * reschedule the timer so the trailing sweep runs after the window has been
   * quiet. The per-PR debounce and timer state is removed once the sweep has
   * executed, so the map cannot grow without bound across PRs.
   * @param prNumber - The PR number with accumulated dismissal work.
   * @param signal - Optional abort signal to cancel the trailing sweep.
   */
  private scheduleTrailingSweep(prNumber: number, signal?: AbortSignal): void {
    const existing = this.timers.get(prNumber);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(prNumber);
      this.lastProcessedAt.delete(prNumber);
      if (signal?.aborted) return;
      void this.runSweep().catch((err) => {
        this.logger.warn(
          `Trailing suppression rule sweep failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(prNumber, timer);
  }

  /**
   * Generate and expire suppression rules using the configured thresholds.
   */
  private async runSweep(): Promise<void> {
    const cfg = this.config?.learning?.suppressionRules ?? DEFAULT_THRESHOLDS;
    if (cfg.enabled === false) return;
    await this.store.generateSuppressionRules({
      minDismissals: cfg.minDismissals,
      ttlDays: cfg.ttlDays,
      maxRules: cfg.maxRules,
      excludeSeverities: cfg.excludeSeverities ?? DEFAULT_THRESHOLDS.excludeSeverities,
    });
    await this.store.expireSuppressionRules(cfg.maxReviews);
  }
}
