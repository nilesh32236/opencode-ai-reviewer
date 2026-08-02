import { Logger } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { isBotUser } from '../utils/bot.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that auto-analyzes newly opened issues with the `needs-analysis` label.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @returns A subscriber object for auto-analysis.
 */
export function createAutoAnalyzeSubscriber(
  rateLimiter: RateLimiter,
  config: AgentConfig,
  eventBus?: EventBus,
): Subscriber {
  const logger = new Logger('AutoAnalyzeSubscriber');
  return {
    name: 'AutoAnalyzeSubscriber',
    subscribedEvents: ['issue.opened'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const issue = payload.issue as Record<string, unknown> | undefined;
        if (!issue) return;
        if (issue.pull_request) return;

        const user = issue.user as Record<string, string> | undefined;
        if (isBotUser(user)) return;

        const issueNumber = (issue.number as number) || 0;
        if (!issueNumber) return;

        const issueLabels =
          (issue.labels as Array<Record<string, string>>)?.map((l) => l.name) || [];
        const skipLabels = ['wontfix', 'duplicate', 'invalid', 'spam'];
        if (skipLabels.some((l) => issueLabels.includes(l))) return;

        const needsAnalysis = issueLabels.includes('needs-analysis');
        if (!needsAnalysis) return;

        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'analyze');
        if (!reservation) return;

        await handleCommand(
          'analyze',
          issueNumber,
          event.repo || '',
          getToken(),
          config,
          undefined,
          signal,
          eventBus,
        );
        await recordRateLimit(rateLimiter, event, 'command', 'analyze', reservation);
      } catch (err) {
        logger.error(`AutoAnalyzeSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
