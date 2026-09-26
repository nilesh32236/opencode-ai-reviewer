import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handleAudit } from '../handlers/audit.js';
import {
  postPrivilegeDenial,
  satisfiesPrivilegeGate,
  verifyPrivilegeGate,
} from '../utils/privilege.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import {
  type RepoFilter,
  repoFilter as defaultRepoFilter,
  isRepoAllowed,
} from '../utils/repo-filter.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/audit` commands on comments.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param repoFilter - Optional repo allowlist/denylist override (defaults to the shared process-wide filter).
 * @returns A subscriber object for the audit command.
 */
export function createAuditSubscriber(
  rateLimiter: RateLimiter,
  config: AgentConfig,
  eventBus?: EventBus,
  repoFilter?: RepoFilter,
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
        if (!isRepoAllowed(event.repo || '', repoFilter ?? defaultRepoFilter)) {
          logger.info(`Skipping /audit for ${event.repo} — repository filtered out`);
          return;
        }
        if (!satisfiesPrivilegeGate(event.payload, event.type)) {
          const rawIssue =
            auditPayload.issue && typeof auditPayload.issue === 'object'
              ? (auditPayload.issue as Record<string, unknown>).number
              : undefined;
          const rawPr =
            auditPayload.pull_request && typeof auditPayload.pull_request === 'object'
              ? (auditPayload.pull_request as Record<string, unknown>).number
              : undefined;
          const deniedTarget =
            typeof rawIssue === 'number'
              ? rawIssue
              : typeof rawPr === 'number'
                ? rawPr
                : typeof event.prNumber === 'number' && event.prNumber > 0
                  ? event.prNumber
                  : undefined;
          logger.info(`Skipping /audit for ${event.repo}#${deniedTarget} — unprivileged author`);
          if (typeof deniedTarget === 'number') {
            await postPrivilegeDenial(event.repo || '', deniedTarget, 'audit');
          }
          return;
        }
        // The hint above is sender-controlled. Confirm the acting identity
        // against the GitHub API before spending any budget: a forged
        // author_association must not be sufficient on its own.
        let verifyToken: string;
        try {
          verifyToken = getToken();
        } catch {
          logger.info(`Skipping /audit for ${event.repo} — no token to verify author`);
          await postPrivilegeDenial(event.repo || '', event.prNumber || 0, 'audit');
          return;
        }
        if (!(await verifyPrivilegeGate(event.payload, event.repo || '', verifyToken))) {
          logger.info(
            `Skipping /audit for ${event.repo}#${event.prNumber} — author failed server verification`,
          );
          await postPrivilegeDenial(event.repo || '', event.prNumber || 0, 'audit');
          return;
        }
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
          event.correlationId,
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
