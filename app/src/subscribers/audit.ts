import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handleAudit } from '../handlers/audit.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/audit` commands on comments.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @returns A subscriber object for the audit command.
 */
export function createAuditSubscriber(
  rateLimiter: RateLimiter,
  config: AgentConfig,
  eventBus?: EventBus,
): Subscriber {
  const logger = new Logger('AuditSubscriber');
  return {
    name: 'AuditSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const auditPayload = event.payload as Record<string, unknown>;
        const auditComment = auditPayload.comment as Record<string, string> | undefined;
        const parsed = auditComment?.body ? parseCommand(auditComment.body) : null;
        if (!parsed || parsed.command !== 'audit') return;
        const auditIssue =
          auditPayload.issue && typeof auditPayload.issue === 'object'
            ? ((auditPayload.issue as Record<string, unknown>).number as number | undefined)
            : ((auditPayload.pull_request as Record<string, unknown> | undefined)?.number as
                | number
                | undefined);
        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'audit', {
          prNumber: auditIssue,
        });
        if (!reservation) return;
        await handleAudit(
          event.repo || '',
          getToken(),
          config,
          undefined,
          undefined,
          undefined,
          signal,
          auditIssue,
          eventBus,
        );
        await recordRateLimit(rateLimiter, event, 'command', 'audit', reservation);
      } catch (err) {
        logger.error(
          `AuditSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
