import { Logger } from '@opencode-pr-agent/lib';
import type { GitHubEvent, LearningStore, RateLimiter, Subscriber } from '@opencode-pr-agent/lib';
import { handleConversation } from '../handlers/conversation.js';
import { buildConfig } from '../utils/config.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles @mention conversations on PRs and issues.
 * @param learningStore - The learning store instance for context and patterns.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @returns A subscriber object for conversation handling.
 */
export function createConversationSubscriber(
  learningStore: LearningStore,
  rateLimiter: RateLimiter,
): Subscriber {
  const logger = new Logger('ConversationSubscriber');
  return {
    name: 'ConversationSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const convPayload = event.payload as Record<string, unknown>;
        const convComment = convPayload.comment as Record<string, unknown> | undefined;
        const convBody = (convComment?.body as string) || '';
        const convUser = (convComment?.user as Record<string, string>)?.login || '';

        const config = buildConfig();
        if (!config.conversation.enabled) return;

        const mentionHandle = config.conversation.mentionHandle;

        if (!convBody.toLowerCase().includes(`@${mentionHandle.toLowerCase()}`)) return;

        if (
          convUser.includes('[bot]') ||
          convUser.includes('github-actions') ||
          convUser.toLowerCase().includes(mentionHandle.toLowerCase())
        ) {
          return;
        }

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const commentId = (convComment?.id as number) || 0;
        if (!commentId) return;

        const isReviewComment = event.type === 'review_comment.created';

        const ok = await checkRateLimit(rateLimiter, event, 'interactive', 'conversation');
        if (!ok) return;

        await handleConversation(
          commentId,
          prNumber,
          event.repo || '',
          getToken(),
          config,
          isReviewComment,
          learningStore,
          signal,
        );
        await recordRateLimit(rateLimiter, event, 'interactive', 'conversation');
      } catch (err) {
        logger.error(
          `ConversationSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
