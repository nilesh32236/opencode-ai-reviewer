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
 * mirroring FeedbackSubscriber's design. Failures degrade gracefully: the
 * review flow never depends on this subscriber succeeding.
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
   * related events produce at most one store sweep per window.
   * @param event - The GitHub webhook event data.
   * @param signal - Optional abort signal to cancel handling.
   */
  async handle(event: GitHubEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    try {
      const prNumber = event.prNumber ?? 0;
      const now = Date.now();
      const lastProcessed = this.lastProcessedAt.get(prNumber);
      if (lastProcessed !== undefined && now - lastProcessed < this.debounceMs) return;
      this.lastProcessedAt.set(prNumber, now);

      const cfg = this.config?.learning?.suppressionRules ?? DEFAULT_THRESHOLDS;
      if (cfg.enabled === false) return;

      await this.store.generateSuppressionRules({
        minDismissals: cfg.minDismissals,
        ttlDays: cfg.ttlDays,
        maxReviews: cfg.maxReviews,
        maxRules: cfg.maxRules,
      });
      await this.store.expireSuppressionRules(cfg.maxReviews);
    } catch (err) {
      this.logger.warn(
        `Suppression rule sweep failed for PR #${event.prNumber} (event: ${event.type}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
