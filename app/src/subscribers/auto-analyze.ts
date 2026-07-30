import { Logger } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that auto-analyzes newly opened issues with the `needs-analysis` label.
 * @returns A subscriber object for auto-analysis.
 */
export function createAutoAnalyzeSubscriber(): Subscriber {
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
        if (user?.type === 'Bot') return;

        const issueNumber = (issue.number as number) || 0;
        if (!issueNumber) return;

        const config = buildConfig();
        const issueLabels =
          (issue.labels as Array<Record<string, string>>)?.map((l) => l.name) || [];
        const skipLabels = ['wontfix', 'duplicate', 'invalid', 'spam'];
        if (skipLabels.some((l) => issueLabels.includes(l))) return;

        const needsAnalysis = issueLabels.includes('needs-analysis');
        if (!needsAnalysis) return;

        await handleCommand('analyze', issueNumber, event.repo || '', getToken(), config, signal);
      } catch (err) {
        logger.error(`AutoAnalyzeSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
