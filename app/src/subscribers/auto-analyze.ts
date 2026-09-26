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
import { satisfiesPrivilegeGate, verifyPrivilegeGate } from '../utils/privilege.js';
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

        // Cost gate (mirrors /analyze): issue.opened carries no comment, but
        // sender.author_association is present, so unprivileged/external issue
        // authors fail closed here instead of burning shared LLM budget. The
        // hint is webhook-supplied and forgeable — confirm the sender
        // server-side via the collaborator-permission API (fail closed,
        // silent skip) before spending LLM budget.
        if (!satisfiesPrivilegeGate(event.payload, event.type)) {
          logger.info(
            'Skipping auto-analyze for ' +
              (event.repo || '') +
              '#' +
              issueNumber +
              ' - unprivileged author',
          );
          return;
        }
        {
          let verifyToken: string;
          try {
            verifyToken = getToken();
          } catch {
            logger.info(
              'Skipping auto-analyze for ' +
                (event.repo || '') +
                '#' +
                issueNumber +
                ' - no token to verify author',
            );
            return;
          }
          const verified = await verifyPrivilegeGate(event.payload, event.repo || '', verifyToken);
          if (!verified) {
            logger.info(
              'Skipping auto-analyze for ' +
                (event.repo || '') +
                '#' +
                issueNumber +
                ' - author failed server verification',
            );
            return;
          }
        }

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
          event.correlationId,
        );
        await recordRateLimit(rateLimiter, event, 'command', 'analyze', reservation);
      } catch (err) {
        logger.error(`AutoAnalyzeSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
