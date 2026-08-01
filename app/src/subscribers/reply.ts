import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, RateLimiter, Subscriber } from '@opencode-pr-agent/lib';
import { handleReply } from '../handlers/reply.js';
import { buildConfig } from '../utils/config.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles reply-to-review comments.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @returns A subscriber object for the reply event.
 */
export function createReplySubscriber(rateLimiter: RateLimiter): Subscriber {
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

        // /dismiss is handled by its dedicated review-thread subscriber; other
        // slash commands have no such subscriber and should still get the
        // conversational reply.
        if (parseCommand(body)?.command === 'dismiss') return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const config = buildConfig();

        const ok = await checkRateLimit(rateLimiter, event, 'interactive', 'reply');
        if (!ok) return;

        await handleReply(prNumber, event.repo || '', getToken(), config, parentId, body);
        await recordRateLimit(rateLimiter, event, 'interactive', 'reply');
      } catch (err) {
        logger.error(`ReplySubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
