import { Logger } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { handleReply } from '../handlers/reply.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

export function createReplySubscriber(): Subscriber {
  const logger = new Logger('App');
  return {
    name: 'ReplySubscriber',
    subscribedEvents: ['review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, unknown> | undefined;
        if (!comment) return;

        const user = comment.user as Record<string, unknown> | undefined;
        if (user?.type === 'Bot') return;

        const parentId = comment.in_reply_to_id as number | undefined;
        if (!parentId) return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const config = buildConfig();
        await handleReply(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          parentId,
          comment.body as string,
        );
      } catch (err) {
        logger.error(`ReplySubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
