import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, ParsedCommand, RateLimiter, Subscriber } from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { buildConfig } from '../utils/config.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/fix` commands and `autofix-trigger` label events.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @returns A subscriber object for the fix command.
 */
export function createFixSubscriber(rateLimiter: RateLimiter): Subscriber {
  const logger = new Logger('FixSubscriber');
  return {
    name: 'FixSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created', 'issue.labeled'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const fixPayload = event.payload as Record<string, unknown>;
        const fixComment = fixPayload.comment as Record<string, string> | undefined;
        const fixIssue = fixPayload.issue as Record<string, unknown> | undefined;
        const fixLabels = fixIssue?.labels as Array<Record<string, string>> | undefined;

        let parsed: ParsedCommand | null = null;
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          parsed = fixComment?.body ? parseCommand(fixComment.body) : null;
          if (!parsed || parsed.command !== 'fix') return;
        }

        if (event.type === 'issue.labeled') {
          const labels = fixLabels?.map((l) => l.name) || [];
          if (!labels.includes('autofix-trigger')) return;
          if (fixIssue?.pull_request) return;
        }

        const config = buildConfig();
        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        // Auto-triggered issue.labeled events have no user-invoked command, so a
        // denial comment would be misleading — enforce silently in that case.
        const isCommandInvoked =
          event.type === 'comment.created' || event.type === 'review_comment.created';
        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'fix', {
          postDenialComment: isCommandInvoked,
        });
        if (!reservation) return;

        const tokensUsed = await handleCommand(
          'fix',
          prNumber,
          event.repo || '',
          getToken(),
          config,
          parsed ?? undefined,
          signal,
        );
        await recordRateLimit(rateLimiter, event, 'command', 'fix', reservation, tokensUsed);
      } catch (err) {
        logger.error(
          `FixSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
