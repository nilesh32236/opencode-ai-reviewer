import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { handleAudit } from '../handlers/audit.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

export function createAuditSubscriber(): Subscriber {
  const logger = new Logger('App');
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
        const config = buildConfig();
        await handleAudit(event.repo || '', getToken(), config);
      } catch (err) {
        logger.error(
          `AuditSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
