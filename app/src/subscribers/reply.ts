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

  /**
   * Slash commands owned by dedicated subscribers that also listen on
   * `review_comment.created`. Defer to them so one threaded reply produces one
   * LLM run and one rate-limit charge, not a duplicate interactive one. Commands
   * without a dedicated subscriber (e.g. `/help`) remain conversational.
   */
  const DEFERRED_REPLY_COMMANDS = new Set([
    'analyze',
    'audit',
    'discover',
    'dismiss',
    'explain',
    'fix',
    'metrics',
    'rate-limits',
    'rate-limits-reset',
    'reconcile-comments',
    'review',
    'setup',
  ]);
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

        // Any slash command owned by a dedicated command subscriber (/review,
        // /fix, /analyze, /dismiss, ...) is handled by that subscriber, which
        // also listens on review_comment.created. Defer here so a single
        // threaded reply produces one LLM run and one rate-limit charge, not a
        // duplicate interactive one.
        const parsedCmd = parseCommand(body);
        if (parsedCmd && DEFERRED_REPLY_COMMANDS.has(parsedCmd.command)) return;

        // A reply that @mentions the bot is handled by ConversationSubscriber,
        // so defer here to avoid double LLM calls and double rate-limit charges.
        const config = buildConfig();
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

        const tokensUsed = await handleReply(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          parentId,
          body,
        );
        await recordRateLimit(rateLimiter, event, 'interactive', 'reply', reservation, tokensUsed);
      } catch (err) {
        logger.error(`ReplySubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
