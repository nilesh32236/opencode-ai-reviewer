import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { EventBus, GitHubEvent, LearningStore, Subscriber } from '@opencode-pr-agent/lib';
import { handlePRReview } from '../handlers/pr-review.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

export function createReviewSubscriber(learningStore: LearningStore, bus: EventBus): Subscriber {
  const logger = new Logger('App');
  return {
    name: 'ReviewSubscriber',
    subscribedEvents: ['pr.opened', 'pr.synchronize', 'comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          const evPayload = event.payload as Record<string, unknown>;
          const commentBody = (evPayload.comment as Record<string, string> | undefined)?.body;
          const parsed = commentBody ? parseCommand(commentBody) : null;
          if (!parsed || parsed.command !== 'review') return;
        }

        const evPayload = event.payload as Record<string, unknown>;
        const pullRequest = evPayload.pull_request as Record<string, unknown> | undefined;
        const prUser = pullRequest?.user as Record<string, string> | undefined;
        const prLabels = pullRequest?.labels as Array<Record<string, string>> | undefined;

        if (event.type === 'pr.opened' || event.type === 'pr.synchronize') {
          if (prUser?.login === 'github-actions[bot]') return;
          const labels = prLabels?.map((l) => l.name) || [];
          if (labels.some((l) => ['autofix', 'autofix:approved', 'autofix:merged'].includes(l)))
            return;
        }

        const config = buildConfig();
        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const previousHeadSha =
          event.type === 'pr.synchronize'
            ? (evPayload.before as string) ||
              ((evPayload.pull_request as Record<string, unknown> | undefined)?.before as string)
            : undefined;

        const result = await handlePRReview(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          learningStore,
          undefined,
          previousHeadSha,
        );
        if (result) {
          try {
            await bus.publish({
              type: 'review.completed',
              category: 'internal',
              payload: {
                prNumber: event.prNumber || 0,
                reviewSummary: result.summary,
                findingsCount: result.issues.length + result.strengths.length,
                issuesCount: result.issues.length,
                strengthsCount: result.strengths.length,
                hasVerdict: !!result.verdict.reasoning,
                fileCount: new Set(result.issues.map((i) => i.file).filter(Boolean)).size,
              },
              timestamp: Date.now(),
              repo: event.repo,
              prNumber: event.prNumber || 0,
            });
          } catch (err) {
            logger.error(
              `Failed to publish review.completed event: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      } catch (err) {
        logger.error(`ReviewSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
