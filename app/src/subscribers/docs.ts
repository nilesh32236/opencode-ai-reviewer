import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  ParsedCommand,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/docs` commands on PRs.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @returns A subscriber object for the docs command.
 */
export function createDocsSubscriber(
  rateLimiter: RateLimiter,
  config: AgentConfig,
  eventBus?: EventBus,
): Subscriber {
  const logger = new Logger('DocsSubscriber');
  return {
    name: 'DocsSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const docsPayload = event.payload as Record<string, unknown>;
        const docsComment = docsPayload.comment as Record<string, string> | undefined;

        let parsed: ParsedCommand | null = null;
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          parsed = docsComment?.body ? parseCommand(docsComment.body) : null;
          if (!parsed || parsed.command !== 'docs') return;
        }

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'docs');
        if (!reservation) return;

        await handleCommand(
          'docs',
          prNumber,
          event.repo || '',
          getToken(),
          config,
          parsed ?? undefined,
          signal,
          eventBus,
          event.correlationId,
        );
        await recordRateLimit(rateLimiter, event, 'command', 'docs', reservation);
      } catch (err) {
        logger.error(
          `DocsSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
