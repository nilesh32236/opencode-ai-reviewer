import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

export function createFixSubscriber(): Subscriber {
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

        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          const parsed = fixComment?.body ? parseCommand(fixComment.body) : null;
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

        await handleCommand('fix', prNumber, event.repo || '', getToken(), config, signal);
      } catch (err) {
        logger.error(
          `FixSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
