import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/analyze` commands on comments.
 * @returns A subscriber object for the analyze command.
 */
export function createAnalyzeSubscriber(): Subscriber {
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
        const config = buildConfig();
        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;
        await handleCommand(
          'analyze',
          issueNumber,
          event.repo || '',
          getToken(),
          config,
          undefined,
          signal,
        );
      } catch (err) {
        logger.error(
          `AnalyzeSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
