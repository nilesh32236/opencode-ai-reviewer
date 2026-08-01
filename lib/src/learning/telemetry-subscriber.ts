import type { GitHubEvent, PipelineEventPayload, Subscriber } from '../types/index.js';
import { PIPELINE_EVENT_TYPES } from '../types/index.js';
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

  /**
   * @param store - The learning store used to persist quality metrics.
   */
  constructor(private readonly store: LearningStore) {}

  /**
   * Record quality metrics for a completed pipeline event when it carries a PR
   * number, duration, or token usage. Events without a PR number (e.g. audits)
   * are skipped because the learning store requires one.
   * @param event - The completed pipeline event.
   */
  async handle(event: GitHubEvent): Promise<void> {
    const payload = event.payload as PipelineEventPayload;
    const prNumber = event.prNumber ?? payload.prNumber;
    if (!prNumber) return;
    if (payload.durationMs === undefined && payload.tokensUsed === undefined) return;

    try {
      await this.store.recordQuality({
        prNumber,
        actionabilityScore: 0,
        accuracyScore: 0,
        coverageScore: 0,
        consistencyScore: 0,
        durationMs: payload.durationMs,
        tokensUsed: payload.tokensUsed,
      });
    } catch {
      // Non-critical: learning store failures must never fail the pipeline.
    }
  }
}
