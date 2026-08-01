import {
  DEFAULT_CONFIG,
  FeedbackSubscriber,
  Logger,
  MetaReviewEngine,
  MetaReviewSubscriber,
  PatternDetector,
} from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  LearningStore,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
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

const logger = new Logger('RateLimiter');

/** How often the rate_limits table is pruned in a long-lived process. */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let shutdownCleanupRegistered = false;

/**
 * Schedule periodic pruning of stale rate-limit rows. A long-lived process
 * would otherwise grow the rate_limits table unbounded (inflating every count
 * and sum query) until the next restart. The timer is unref'd so it never keeps
 * the process alive, and it is cleared on shutdown signals.
 * @param rateLimiter - The shared rate limiter whose cleanup is run periodically.
 */
function schedulePeriodicCleanup(rateLimiter: RateLimiter): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    rateLimiter.cleanup().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Rate limiter periodic cleanup failed: ${msg}`);
    });
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  if (!shutdownCleanupRegistered) {
    shutdownCleanupRegistered = true;
    const clearTimer = (): void => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    };
    process.once('SIGTERM', clearTimer);
    process.once('SIGINT', clearTimer);
  }
}

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

  const subscribers: Subscriber[] = [
    createReviewSubscriber(learningStore, bus, rateLimiter),
    createFixSubscriber(rateLimiter),
    createAuditSubscriber(rateLimiter),
    createAnalyzeSubscriber(rateLimiter),
    createAutoAnalyzeSubscriber(rateLimiter),
    createQuestionAnsweredSubscriber(),
    createReplySubscriber(rateLimiter),
    createDismissSubscriber(learningStore),
    createExplainSubscriber(rateLimiter),
    createConversationSubscriber(learningStore, rateLimiter),
    createSetupSubscriber(),
    createAdminSubscriber(rateLimiter, resolvedConfig),
  ];

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

  // ...and periodically, so a long-lived process does not accumulate stale rows.
  schedulePeriodicCleanup(rateLimiter);

  bus.registerAll(subscribers);

  return subscribers;
}
