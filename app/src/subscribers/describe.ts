import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/describe` commands on comments.
 * @param rateLimiter - The shared rate limiter for cost control (nullable when
 * rate limiting is unavailable, matching the `checkRateLimit` contract).
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @returns A subscriber object for the describe command.
 */
export function createDescribeSubscriber(
  rateLimiter: RateLimiter | null,
  config: AgentConfig,
  eventBus?: EventBus,
): Subscriber {
  const logger = new Logger('DescribeSubscriber');
  return {
    name: 'DescribeSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, string> | undefined;
        const parsed = comment?.body ? parseCommand(comment.body) : null;
        if (!parsed || parsed.command !== 'describe') return;
        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;

        if (config.describe?.enabled === false) {
          logger.info(`Skipping /describe for ${event.repo}#${issueNumber} — describe disabled`);
          return;
        }

        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'describe');
        if (!reservation) return;
        await handleCommand(
          'describe',
          issueNumber,
          event.repo || '',
          getToken(),
          config,
          undefined,
          signal,
          eventBus,
          event.correlationId,
        );
        await recordRateLimit(rateLimiter, event, 'command', 'describe', reservation);
      } catch (err) {
        logger.error(
          `DescribeSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
