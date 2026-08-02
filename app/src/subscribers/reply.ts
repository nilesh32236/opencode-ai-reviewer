import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { AgentConfig, GitHubEvent, RateLimiter, Subscriber } from '@opencode-pr-agent/lib';
import { handleReply } from '../handlers/reply.js';
import { isBotUser } from '../utils/bot.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles reply-to-review comments.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @returns A subscriber object for the reply event.
 */
export function createReplySubscriber(rateLimiter: RateLimiter, config: AgentConfig): Subscriber {
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
        if (isBotUser(user)) return;

        const parentId = comment.in_reply_to_id as number | undefined;
        if (!parentId) return;

        const body = comment.body as string | undefined;
        if (!body) return;

        // /dismiss is handled by its dedicated review-thread subscriber; other
        // slash commands have no such subscriber and should still get the
        // conversational reply.
        if (parseCommand(body)?.command === 'dismiss') return;

        // A reply that @mentions the bot is handled by ConversationSubscriber,
        // so defer here to avoid double LLM calls and double rate-limit charges.
        const mentionHandle = config.conversation.mentionHandle ?? '';
        if (
          config.conversation.enabled &&
          mentionHandle &&
          body.toLowerCase().includes(`@${mentionHandle.toLowerCase()}`)
        ) {
          return;
        }

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const reservation = await checkRateLimit(rateLimiter, event, 'interactive', 'reply');
        if (!reservation) return;

        await handleReply(prNumber, event.repo || '', getToken(), config, parentId, body);
        await recordRateLimit(rateLimiter, event, 'interactive', 'reply', reservation);
      } catch (err) {
        logger.error(`ReplySubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
