import * as os from 'node:os';
import * as path from 'node:path';
import { ConversationStateManager, Logger } from '@opencode-pr-agent/lib';
import type { EventBus, GitHubEvent, LearningStore, RateLimiter, Subscriber } from '@opencode-pr-agent/lib';
import { handleConversation } from '../handlers/conversation.js';
import { buildConfig } from '../utils/config.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles @mention conversations on PRs and issues.
 *
 * A long-lived `ConversationStateManager` is owned by the subscriber so tracked
 * state (turn count, summary snapshots) survives across individual webhook
 * turns — otherwise every @mention would start with empty state and the sliding
 * window/summarization logic would never accumulate.
 *
 * @param learningStore - The learning store instance for context and patterns.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @returns A subscriber object for conversation handling.
 */
export function createConversationSubscriber(
  learningStore: LearningStore,
  rateLimiter: RateLimiter,
  eventBus?: EventBus,
): Subscriber {
  const logger = new Logger('ConversationSubscriber');
  const conversationStateManager = new ConversationStateManager();
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

        const reservation = await checkRateLimit(rateLimiter, event, 'interactive', 'conversation');
        if (!reservation) return;

        // Each conversation gets its own scratch directory under the OS temp dir
        // so concurrent webhooks (Probot handles them concurrently) never clobber
        // each other's `.opencode/conversation-output.txt` / `conversation-summary.txt`.
        const convWorkDir = path.join(
          os.tmpdir(),
          'opencode-conv',
          `${(event.repo || '').replace('/', '-')}-${prNumber}-${commentId}`,
        );

        await handleConversation(
          commentId,
          prNumber,
          event.repo || '',
          getToken(),
          config,
          isReviewComment,
          learningStore,
          signal,
          convWorkDir,
          conversationStateManager,
          eventBus,
        );
        await recordRateLimit(rateLimiter, event, 'interactive', 'conversation', reservation);
      } catch (err) {
        logger.error(
          `ConversationSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
