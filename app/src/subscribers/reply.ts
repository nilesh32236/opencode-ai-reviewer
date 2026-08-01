import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { handleReply } from '../handlers/reply.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles reply-to-review comments.
 * @returns A subscriber object for the reply event.
 */
export function createReplySubscriber(): Subscriber {
  const logger = new Logger('ReplySubscriber');
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

        const body = comment.body as string | undefined;
        if (!body) return;

        // Slash commands (e.g. /dismiss) are handled by dedicated subscribers,
        // not by the conversational reply flow.
        if (parseCommand(body)) return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const config = buildConfig();
        await handleReply(prNumber, event.repo || '', getToken(), config, parentId, body);
      } catch (err) {
        logger.error(`ReplySubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
