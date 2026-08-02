import {
  DEFAULT_CONFIG,
  FeedbackSubscriber,
  Logger,
  MetaReviewEngine,
  MetaReviewSubscriber,
  PatternDetector,
  TelemetrySubscriber,
} from '@opencode-pr-agent/lib';
import type { AgentConfig, EventBus, LearningStore, Subscriber } from '@opencode-pr-agent/lib';
import { createRateLimiter } from '../utils/rate-limit.js';
import { createAdminSubscriber } from './admin.js';
import { createAnalyzeSubscriber } from './analyze.js';
import { createAuditSubscriber } from './audit.js';
import { createAutoAnalyzeSubscriber } from './auto-analyze.js';
import { createConversationSubscriber } from './conversation.js';
import { createDiscoverSubscriber } from './discover.js';
import { createDismissSubscriber } from './dismiss.js';
import { createExplainSubscriber } from './explain.js';
import { createFixSubscriber } from './fix.js';
import { createMetricsSubscriber } from './metrics.js';
import { createQuestionAnsweredSubscriber } from './question-answered.js';
import { createReplySubscriber } from './reply.js';
import { createReviewSubscriber } from './review.js';
import { createSetupSubscriber } from './setup.js';

/**
 * Register all event subscribers with the event bus.
 * @param bus - The EventBus instance.
 * @param learningStore - The LearningStore instance.
 * @param config - Optional agent config (defaults to DEFAULT_CONFIG).
 * @returns The array of registered subscribers.
 */
export function registerSubscribers(
  bus: EventBus,
  learningStore: LearningStore,
  config?: AgentConfig,
): Subscriber[] {
  const resolvedConfig = config ?? DEFAULT_CONFIG;
  const rateLimiter = createRateLimiter(learningStore, resolvedConfig);
  const logger = new Logger('RateLimiter');

  const subscribers: Subscriber[] = [
    createReviewSubscriber(learningStore, bus, rateLimiter, resolvedConfig),
    createFixSubscriber(rateLimiter, resolvedConfig, bus),
    createAuditSubscriber(rateLimiter, resolvedConfig, bus),
    createAnalyzeSubscriber(rateLimiter, resolvedConfig, bus),
    createAutoAnalyzeSubscriber(rateLimiter, resolvedConfig, bus),
    createQuestionAnsweredSubscriber(),
    createReplySubscriber(rateLimiter, resolvedConfig),
    createDismissSubscriber(learningStore, resolvedConfig),
    createExplainSubscriber(rateLimiter, resolvedConfig, bus),
    createConversationSubscriber(learningStore, rateLimiter, resolvedConfig, bus),
    createSetupSubscriber(resolvedConfig),
    createAdminSubscriber(rateLimiter, resolvedConfig),
  ];

  // Persist duration/token telemetry for completed pipeline stages into the
  // learning store so /metrics keeps reporting latency and token usage.
  subscribers.push(new TelemetrySubscriber(learningStore));

  const feedbackSub = new FeedbackSubscriber(learningStore);
  subscribers.push(feedbackSub);

  const patternDetector = new PatternDetector(learningStore, {
    windowSize: DEFAULT_CONFIG.learning.patternDiscovery.windowSize,
  });
  const metaReviewEngine = new MetaReviewEngine(learningStore, patternDetector, resolvedConfig);
  const metaReviewSub = new MetaReviewSubscriber(
    metaReviewEngine,
    learningStore,
    DEFAULT_CONFIG.learning.metaReview.interval,
  );
  subscribers.push(metaReviewSub);

  subscribers.push(createDiscoverSubscriber(learningStore, rateLimiter));
  subscribers.push(createMetricsSubscriber(learningStore));

  // Prune stale rate-limit rows once at startup.
  rateLimiter.cleanup().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Rate limiter cleanup failed: ${msg}`);
  });

  bus.registerAll(subscribers);

  return subscribers;
}
