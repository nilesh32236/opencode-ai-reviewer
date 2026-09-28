import { GitHubHelper, Logger } from '@opencode-pr-agent/lib';
import type { GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import { isBotUser } from '../utils/bot.js';
import { getToken } from '../utils/token.js';

const QUESTIONS_MARKER = '<!-- issue-analysis-questions -->';

/**
 * Narrow an untrusted `comment.user` value to something the bot check can use.
 * @param raw - Whatever the payload carried under `comment.user`.
 * @returns A `{ login, type }` view, or undefined when it is not an object.
 */
function toBotCheckableUser(raw: unknown): { login?: unknown; type?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as { login?: unknown; type?: unknown };
  return { login: u.login, type: typeof u.type === 'string' ? u.type : undefined };
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

        // Fail closed on an ABSENT or non-string comment author. The previous
        // guard (`user?.login && user.login !== issueAuthor`) short-circuited on
        // a missing `comment.user`, and `isBotUser(undefined)` is false, so a
        // payload with no comment author skipped the author check entirely and
        // still flipped the issue to `analysis:ready` and posted a public
        // comment. An actor we cannot name is not the issue author. The payload
        // is narrowed rather than cast, because `comment.user` is untrusted JSON.
        const user = toBotCheckableUser(comment.user);
        if (isBotUser(user)) return;
        const login = typeof user?.login === 'string' ? user.login : undefined;
        if (!login) return;

        // Every guard so far is zero-I/O, and they are ordered ahead of the API
        // work on purpose: this subscriber sees every `comment.created` in the
        // installation, so the untrusted path is the common one and nothing
        // cheap should follow something expensive.
        const labels = (issue.labels as Array<Record<string, string>>)?.map((l) => l.name) ?? [];
        if (!labels.includes('analysis:needs-input')) return;

        const issueNumber = (issue.number as number) || 0;
        if (!issueNumber) return;

        const gh = new GitHubHelper(getToken(), event.repo || '');
        // The author is resolved from GitHub's own record, not from
        // `issue.user.login` in this delivery: two fields of one payload are a
        // consistency check, not authentication, and a forger who controls the
        // delivery controls both. GitHub logins are case-insensitive, so both
        // sides are normalized — an account rename or a differently-cased
        // delivery must not strand the issue on `analysis:needs-input`.
        const issueContext = await gh.getIssue(issueNumber, undefined, signal);
        const issueAuthor = issueContext?.author;
        if (typeof issueAuthor !== 'string' || login.toLowerCase() !== issueAuthor.toLowerCase()) {
          return;
        }

        const questionsComment = issueContext.comments.find((c) =>
          c.body.startsWith(QUESTIONS_MARKER),
        );
        if (!questionsComment) return;

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
