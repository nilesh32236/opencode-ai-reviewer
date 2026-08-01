import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { buildConfig } from '../utils/config.js';

/**
 * Create a subscriber that handles `/setup` commands on comments.
 * @returns A subscriber object for the setup command.
 */
export function createSetupSubscriber(): Subscriber {
  const logger = new Logger('SetupSubscriber');
  return {
    name: 'SetupSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const setupPayload = event.payload as Record<string, unknown>;
        const setupComment = setupPayload.comment as Record<string, string> | undefined;
        const parsed = setupComment?.body ? parseCommand(setupComment.body) : null;
        if (!parsed || parsed.command !== 'setup') return;
        const config = buildConfig();
        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;
        // Pass the raw token (possibly empty) so the setup engine can produce a
        // diagnostic report instead of aborting the flow before it starts.
        const token = process.env.GITHUB_TOKEN || '';
        await handleCommand('setup', issueNumber, event.repo || '', token, config, parsed, signal);
      } catch (err) {
        logger.error(
          `SetupSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
