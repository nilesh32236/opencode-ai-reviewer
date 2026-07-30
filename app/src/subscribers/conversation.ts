import { Logger } from '@opencode-pr-agent/lib';
import type { GitHubEvent, LearningStore, Subscriber } from '@opencode-pr-agent/lib';
import { handleConversation } from '../handlers/conversation.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

export function createConversationSubscriber(learningStore: LearningStore): Subscriber {
  const logger = new Logger('App');
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
        const mentionHandle = config.conversation.mentionHandle;

        if (!convBody.toLowerCase().includes(`@${mentionHandle.toLowerCase()}`)) return;

        if (
          convUser.includes('[bot]') ||
          convUser.includes('github-actions') ||
          convUser.toLowerCase().includes(mentionHandle.toLowerCase())
        ) {
          return;
        }

        if (!config.conversation.enabled) return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const commentId = (convComment?.id as number) || 0;
        if (!commentId) return;

        const isReviewComment = event.type === 'review_comment.created';

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
      } catch (err) {
        logger.error(
          `ConversationSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
