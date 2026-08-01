import type { GitHubEvent, PipelineEventPayload, Subscriber } from '../types/index.js';
import { PIPELINE_EVENT_TYPES } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import type { LearningStore } from './store.js';

/**
 * Subscriber that records review quality telemetry into the learning store
 * whenever a pipeline stage completes. Replaces the learning-store write that
 * used to live inside `ReviewEngine.recordTelemetry`, decoupling it from the
 * engine so it is only exercised when the event bus is wired up.
 */
export class TelemetrySubscriber implements Subscriber {
  name = 'TelemetrySubscriber';
  subscribedEvents = Object.values(PIPELINE_EVENT_TYPES).filter((t) => t.endsWith('.completed'));

  private logger = new Logger('TelemetrySubscriber');

  /**
   * @param store - The learning store used to persist quality metrics.
   */
  constructor(private readonly store: LearningStore) {}

  /**
   * Record quality metrics for a completed pipeline event when it carries a PR
   * number and duration/token usage. Events without a PR number (e.g. audits)
   * or without any resource telemetry are skipped because there is nothing to
   * persist.
   *
   * Pipeline events do not carry quality scores, so the recorded rows have
   * zero scores and exist purely to feed duration/token telemetry; the metrics
   * aggregation paths (`aggregateMetrics`) exclude zero-score rows from quality
   * averages, mirroring `getQualityTrends`.
   * @param event - The completed pipeline event.
   */
  async handle(event: GitHubEvent): Promise<void> {
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null) return;
    const typed = payload as PipelineEventPayload;
    const prNumber = event.prNumber ?? typed.prNumber;
    if (!prNumber) return;
    if (typed.durationMs === undefined && typed.tokensUsed === undefined) return;

    try {
      await this.store.recordQuality({
        prNumber,
        actionabilityScore: 0,
        accuracyScore: 0,
        coverageScore: 0,
        consistencyScore: 0,
        durationMs: typed.durationMs,
        tokensUsed: typed.tokensUsed,
      });
    } catch (err) {
      // Non-critical: learning store failures must never fail the pipeline.
      this.logger.warn(
        `Failed to record telemetry for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
