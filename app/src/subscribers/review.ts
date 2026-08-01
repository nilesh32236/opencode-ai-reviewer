import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  EventBus,
  GitHubEvent,
  LearningStore,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handlePRReview } from '../handlers/pr-review.js';
import { buildConfig } from '../utils/config.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles PR review, re-review on push, and `/review` commands.
 * @param learningStore - The learning store instance for review context.
 * @param bus - The event bus used by the review engine to publish pipeline events.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @returns A subscriber object for the review command.
 */
export function createReviewSubscriber(
  learningStore: LearningStore,
  bus: EventBus,
  rateLimiter: RateLimiter,
): Subscriber {
  const logger = new Logger('ReviewSubscriber');
  return {
    name: 'ReviewSubscriber',
    subscribedEvents: ['pr.opened', 'pr.synchronize', 'comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          const evPayload = event.payload as Record<string, unknown>;
          const commentBody = (evPayload.comment as Record<string, string> | undefined)?.body;
          const parsed = commentBody ? parseCommand(commentBody) : null;
          if (!parsed || parsed.command !== 'review') return;
        }

        const evPayload = event.payload as Record<string, unknown>;
        const pullRequest = evPayload.pull_request as Record<string, unknown> | undefined;
        const prUser = pullRequest?.user as Record<string, string> | undefined;
        const prLabels = pullRequest?.labels as Array<Record<string, string>> | undefined;

        if (event.type === 'pr.opened' || event.type === 'pr.synchronize') {
          if (prUser?.login === 'github-actions[bot]') return;
          const labels = prLabels?.map((l) => l.name) || [];
          if (labels.some((l) => ['autofix', 'autofix:approved', 'autofix:merged'].includes(l)))
            return;
        }

        const config = buildConfig();
        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        // Auto-triggered events (pr.opened / pr.synchronize) go through the same
        // command-tier guardrails, but no user invoked the bot, so a denial comment
        // would be misleading — enforce silently in that case.
        const isCommandInvoked =
          event.type === 'comment.created' || event.type === 'review_comment.created';
        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'review', {
          postDenialComment: isCommandInvoked,
        });
        if (!reservation) return;

        const previousHeadSha =
          event.type === 'pr.synchronize'
            ? (evPayload.before as string) ||
              ((evPayload.pull_request as Record<string, unknown> | undefined)?.before as string)
            : undefined;

        const result = await handlePRReview(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          learningStore,
          undefined,
          previousHeadSha,
          bus,
        );
        if (result) {
          await recordRateLimit(
            rateLimiter,
            event,
            'command',
            'review',
            reservation,
            result.usage?.totalTokens,
          );
        }
      } catch (err) {
        logger.error(`ReviewSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
