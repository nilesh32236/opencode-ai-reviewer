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
 * Create a subscriber that handles `/changelog` commands on issues and PRs.
 * @param rateLimiter - The shared rate limiter for cost control (null when
 * rate limiting is unavailable, matching the `checkRateLimit` contract).
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @returns A subscriber object for the changelog command.
 */
export function createChangelogSubscriber(
  rateLimiter: RateLimiter | null,
  config: AgentConfig,
  eventBus?: EventBus,
): Subscriber {
  const logger = new Logger('ChangelogSubscriber');
  return {
    name: 'ChangelogSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const changelogPayload = event.payload as Record<string, unknown>;
        const changelogComment = changelogPayload.comment as Record<string, string> | undefined;

        // subscribedEvents only includes comment.created and
        // review_comment.created, so the event type is always one of them.
        const parsed = changelogComment?.body ? parseCommand(changelogComment.body) : null;
        if (!parsed || parsed.command !== 'changelog') return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        if (config.changelog?.enabled === false) {
          logger.info(`Skipping /changelog for ${event.repo}#${prNumber} — changelog disabled`);
          return;
        }

        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'changelog');
        if (!reservation) return;

        await handleCommand(
          'changelog',
          prNumber,
          event.repo || '',
          getToken(),
          config,
          parsed,
          signal,
          eventBus,
          event.correlationId,
        );
        await recordRateLimit(rateLimiter, event, 'command', 'changelog', reservation);
      } catch (err) {
        logger.error(
          `ChangelogSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
