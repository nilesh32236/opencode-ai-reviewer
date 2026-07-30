import { GitHubHelper, Logger } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { getToken } from '../utils/token.js';

export function createQuestionAnsweredSubscriber(): Subscriber {
  const logger = new Logger('QuestionAnsweredSubscriber');
  return {
    name: 'QuestionAnsweredSubscriber',
    subscribedEvents: ['comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, unknown> | undefined;
        const issue = payload.issue as Record<string, unknown> | undefined;

        if (!comment || !issue) return;
        if (issue.pull_request) return;
        const user = comment.user as Record<string, string> | undefined;
        if (user?.type === 'Bot') return;

        const labels = (issue.labels as Array<Record<string, string>>)?.map((l) => l.name) ?? [];
        if (!labels.includes('analysis:needs-input')) return;

        const issueNumber = (issue.number as number) || 0;
        if (!issueNumber) return;

        const gh = new GitHubHelper(getToken(), event.repo || '');
        const issueComments = await gh.getIssueComments(issueNumber);
        const questionsComment = issueComments.find((c) =>
          c.body.startsWith('<!-- issue-analysis-questions -->'),
        );
        if (!questionsComment) return;

        const issueAuthor = (issue.user as Record<string, string> | undefined)?.login;
        const actor = comment.user as Record<string, string> | undefined;
        if (actor?.login && actor.login !== issueAuthor) return;

        await gh.setLabels(issueNumber, ['analysis:ready'], ['analysis:needs-input']);
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- analysis-answers-received -->',
          '✅ **Answers received.** You can now comment `/fix` to start the implementation.',
        );

        logger.info(`Received answers for issue #${issueNumber} — marked as analysis:ready`);
      } catch (err) {
        logger.error(
          `QuestionAnsweredSubscriber failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
