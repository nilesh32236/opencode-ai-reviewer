import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/explain` commands on comments.
 * @returns A subscriber object for the explain command.
 */
export function createExplainSubscriber(): Subscriber {
  const logger = new Logger('ExplainSubscriber');
  return {
    name: 'ExplainSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, string> | undefined;
        const parsed = comment?.body ? parseCommand(comment.body) : null;
        if (!parsed || parsed.command !== 'explain') return;
        const config = buildConfig();
        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;
        await handleCommand(
          'explain',
          issueNumber,
          event.repo || '',
          getToken(),
          config,
          undefined,
          signal,
        );
      } catch (err) {
        logger.error(
          `ExplainSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
