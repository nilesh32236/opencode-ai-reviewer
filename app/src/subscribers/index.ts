import {
  DEFAULT_CONFIG,
  FeedbackSubscriber,
  MetaReviewEngine,
  MetaReviewSubscriber,
  PatternDetector,
} from '@opencode-pr-agent/lib';
import type { EventBus, LearningStore, Subscriber } from '@opencode-pr-agent/lib';
import { createAnalyzeSubscriber } from './analyze.js';
import { createAuditSubscriber } from './audit.js';
import { createAutoAnalyzeSubscriber } from './auto-analyze.js';
import { createConversationSubscriber } from './conversation.js';
import { createDiscoverSubscriber } from './discover.js';
import { createExplainSubscriber } from './explain.js';
import { createFixSubscriber } from './fix.js';
import { createMetricsSubscriber } from './metrics.js';
import { createQuestionAnsweredSubscriber } from './question-answered.js';
import { createReplySubscriber } from './reply.js';
import { createReviewSubscriber } from './review.js';

/**
 * Register all event subscribers with the event bus.
 * @param bus - The EventBus instance.
 * @param learningStore - The LearningStore instance.
 * @returns The array of registered subscribers.
 */
export function registerSubscribers(bus: EventBus, learningStore: LearningStore): Subscriber[] {
  const subscribers: Subscriber[] = [
    createReviewSubscriber(learningStore, bus),
    createFixSubscriber(),
    createAuditSubscriber(),
    createAnalyzeSubscriber(),
    createAutoAnalyzeSubscriber(),
    createQuestionAnsweredSubscriber(),
    createReplySubscriber(),
    createExplainSubscriber(),
    createConversationSubscriber(learningStore),
  ];

  const feedbackSub = new FeedbackSubscriber(learningStore);
  subscribers.push(feedbackSub);

  const patternDetector = new PatternDetector(learningStore, {
    windowSize: DEFAULT_CONFIG.learning.patternDiscovery.windowSize,
  });
  const metaReviewEngine = new MetaReviewEngine(learningStore, patternDetector);
  const metaReviewSub = new MetaReviewSubscriber(
    metaReviewEngine,
    learningStore,
    DEFAULT_CONFIG.learning.metaReview.interval,
  );
  subscribers.push(metaReviewSub);

  subscribers.push(createDiscoverSubscriber(learningStore));
  subscribers.push(createMetricsSubscriber(learningStore));

  bus.registerAll(subscribers);

  return subscribers;
}
