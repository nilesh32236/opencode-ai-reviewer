import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { postPrivilegeDenial, satisfiesPrivilegeGate } from '../utils/privilege.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/analyze` commands on comments.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @returns A subscriber object for the analyze command.
 */
export function createAnalyzeSubscriber(
  rateLimiter: RateLimiter,
  config: AgentConfig,
  eventBus?: EventBus,
): Subscriber {
  const logger = new Logger('AnalyzeSubscriber');
  return {
    name: 'AnalyzeSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const analyzePayload = event.payload as Record<string, unknown>;
        const analyzeComment = analyzePayload.comment as Record<string, string> | undefined;
        const parsed = analyzeComment?.body ? parseCommand(analyzeComment.body) : null;
        if (!parsed || parsed.command !== 'analyze') return;
        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;
        if (!satisfiesPrivilegeGate(event.payload)) {
          logger.info(`Skipping /analyze for ${event.repo}#${issueNumber} — unprivileged author`);
          await postPrivilegeDenial(event.repo || '', issueNumber, 'analyze');
          return;
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
        logger.error(
          `AnalyzeSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
