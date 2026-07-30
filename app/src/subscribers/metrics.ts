import { GitHubHelper, Logger, MetricsService, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, LearningStore, Subscriber } from '@opencode-pr-agent/lib';
import { getToken } from '../utils/token.js';

export function createMetricsSubscriber(learningStore: LearningStore): Subscriber {
  const logger = new Logger('App');
  return {
    name: 'MetricsSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, string> | undefined;
        const parsed = comment?.body ? parseCommand(comment.body) : null;
        if (!parsed || parsed.command !== 'metrics') return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const gh = new GitHubHelper(getToken(), event.repo || '');
        const metricsService = new MetricsService(learningStore);
        const period = parsed.args[0] === 'weekly' ? 'weekly' : 'daily';
        const sinceDays = period === 'weekly' ? 7 : 1;
        const report = await metricsService.getReport({ period, sinceDays });
        const markdown = metricsService.formatReport(report);
        await gh.postOrUpdateComment(prNumber, '<!-- metrics-report -->', markdown);
      } catch (err) {
        logger.error(
          `MetricsSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
