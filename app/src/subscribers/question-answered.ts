import { GitHubHelper, Logger, sanitizeErrorMessage } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { isBotUser } from '../utils/bot.js';
import { getToken } from '../utils/token.js';

/**
 * Read a GitHub login defensively.
 *
 * Only a string counts as an identity. A number, array, or object in the
 * `login` field must not be coerced into a comparison that can match, and an
 * absent field must never be treated as a wildcard.
 * @param value - Candidate `{ login }` object from a webhook payload.
 * @returns The login string, or undefined when absent or not a string.
 */
function readLogin(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const login = (value as Record<string, unknown>).login;
  return typeof login === 'string' && login.length > 0 ? login : undefined;
}

/**
 * Create a subscriber that detects when an `analysis:needs-input` issue receives a reply from the author.
 * @returns A subscriber object for the question-answered event.
 */
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
        if (isBotUser(user)) return;

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

        const issueAuthor = readLogin(issue.user);
        const actorLogin = readLogin(user);
        // Both sides must be present and equal. The previous form --
        // `if (user?.login && user.login !== issueAuthor) return` -- short-circuited
        // on a MISSING actor login, so a payload without `comment.user.login` skipped
        // the author check entirely and advanced the issue on anyone's behalf
        // (issue #922). Mirrors the fail-closed rule `verifyPrivilegeGate` already
        // applies: an absent or non-string identity is not a match.
        if (!actorLogin || !issueAuthor || actorLogin !== issueAuthor) return;

        await gh.setLabels(issueNumber, ['analysis:ready'], ['analysis:needs-input']);
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- analysis-answers-received -->',
          '✅ **Answers received.** You can now comment `/fix` to start the implementation.',
        );

        logger.info(`Received answers for issue #${issueNumber} — marked as analysis:ready`);
      } catch (err) {
        logger.error(`QuestionAnsweredSubscriber failed: ${sanitizeErrorMessage(err)}`);
      }
    },
  };
}
