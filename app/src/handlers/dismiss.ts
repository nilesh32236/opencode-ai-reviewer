import type {
  AgentConfig,
  LearningStore,
  ParsedCommand,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import { GitHubHelper, GitLabAdapter, Logger } from '@opencode-pr-agent/lib';

/** Structured dismissal reasons a user can pick from. */
const DISMISS_REASONS = ['false_positive', 'intentional', 'out_of_scope', 'other'] as const;

/** Default reason applied when none is given or the value is not recognized. */
const DEFAULT_DISMISS_REASON = 'other';

/**
 * Extract a structured dismissal reason from a parsed `/dismiss` command.
 * Supports both a positional argument (`/dismiss false_positive`) and an
 * explicit flag (`/dismiss --reason=intentional`). Unknown or missing reasons
 * fall back to `other`.
 * @param parsed - The parsed slash command.
 * @returns A valid dismissal reason string.
 */
export function parseDismissReason(parsed: ParsedCommand): string {
  const flagReason = typeof parsed.flags.reason === 'string' ? parsed.flags.reason : undefined;
  const candidate = flagReason ?? parsed.args[0];
  return (DISMISS_REASONS as readonly string[]).includes(candidate ?? '')
    ? (candidate as string)
    : DEFAULT_DISMISS_REASON;
}

/**
 * Build the acknowledgment comment posted on a dismissed review thread.
 * @param reason - The structured dismissal reason.
 * @returns The markdown acknowledgment body.
 */
export function buildDismissAck(reason: string): string {
  return [
    '✅ **Comment dismissed** — this feedback has been recorded.',
    '',
    `Reason: \`${reason}\``,
    '',
    'Future reviews will account for this feedback.',
  ].join('\n');
}

/**
 * Handle a `/dismiss` command issued as a reply on a bot review thread.
 *
 * Verifies the reply targets a bot comment, records dismissal feedback against
 * the matching finding(s) in the learning store, minimizes the bot's comment
 * (hiding it behind GitHub's "Show resolved" toggle), and posts a brief
 * acknowledgment on the thread. All failure paths degrade gracefully so a
 * dismissal never crashes the webhook handler.
 *
 * @param prNumber - PR number.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param store - Learning store used to persist dismissal feedback.
 * @param parentCommentId - ID of the bot comment being dismissed (the reply's `in_reply_to_id`).
 * @param parsed - The parsed `/dismiss` command.
 */
export async function handleDismissCommand(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  store: LearningStore,
  parentCommentId: number,
  parsed: ParsedCommand,
): Promise<void> {
  const logger = new Logger('Dismiss', { repo, prNumber });
  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const reason = parseDismissReason(parsed);

  try {
    const thread = await gh.getReviewCommentThread(parentCommentId, prNumber);

    const parentComment = thread.comments.find((c) => c.id === parentCommentId);
    if (!parentComment || !parentComment.isBot) {
      logger.info(`Comment ${parentCommentId} is not from the bot — skipping dismissal`);
      return;
    }

    let matched: Array<{ id: string }> = [];
    try {
      const findings = await store.getFindings(prNumber);
      matched = findings.filter((f) => {
        if (!f.id || typeof f.id !== 'string') return false;
        if (thread.filePath && typeof f.file === 'string' && f.file !== thread.filePath) {
          return false;
        }
        if (
          thread.lineNumber !== undefined &&
          typeof f.line === 'number' &&
          f.line !== thread.lineNumber
        ) {
          return false;
        }
        return true;
      });
    } catch (err) {
      logger.warn(
        `Failed to fetch findings for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (matched.length > 0) {
      try {
        await store.recordFeedbackBatch(
          matched.map((f) => ({
            findingId: f.id,
            signalType: 'dismissed' as const,
            signalValue: reason,
            prNumber,
          })),
        );
        logger.info(
          `Recorded dismissal feedback for ${matched.length} finding(s) with reason "${reason}"`,
        );
      } catch (err) {
        logger.warn(
          `Failed to record dismissal feedback: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else {
      logger.info(`No findings matched dismissed comment ${parentCommentId}`);
    }

    try {
      const botThreads = await gh.getBotReviewThreads(prNumber);
      const match = botThreads.find((t) => t.firstComment.databaseId === parentCommentId);
      if (match) {
        await gh.minimizeReviewComment(match.firstComment.commentId, 'RESOLVED');
        logger.info(`Minimized bot review comment ${parentCommentId}`);
      } else {
        logger.info(`No bot thread found for comment ${parentCommentId} — skipping minimize`);
      }
    } catch (err) {
      logger.warn(`Failed to minimize comment: ${err instanceof Error ? err.message : err}`);
    }

    try {
      await gh.replyToReviewComment(prNumber, parentCommentId, buildDismissAck(reason));
      logger.info(`Posted dismissal acknowledgment on comment ${parentCommentId}`);
    } catch (err) {
      logger.warn(
        `Failed to post dismissal acknowledgment: ${err instanceof Error ? err.message : err}`,
      );
    }
  } catch (err) {
    logger.error(
      `Dismiss command failed for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
