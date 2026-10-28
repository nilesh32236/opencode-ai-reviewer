import type {
  AgentConfig,
  LearningStore,
  ParsedCommand,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import { Logger, createPlatformAdapter } from '@opencode-pr-agent/lib';
import { isPrivilegedAuthor } from '../utils/privilege.js';

// Re-export the shared privileged-author check so existing importers
// (subscribers/dismiss.ts, tests) keep working while all callers share one definition.
export { isPrivilegedAuthor };

/** Structured dismissal reasons a user can pick from. */
const DISMISS_REASONS = ['false_positive', 'intentional', 'out_of_scope', 'other'] as const;

/** Default reason applied when none is given or the value is not recognized. */
const DEFAULT_DISMISS_REASON = 'other';

/**
 * Extract the reason the user actually supplied, without validating it.
 * @param parsed - The parsed slash command.
 * @returns The supplied reason, or undefined when none was given.
 */
function getSuppliedReason(parsed: ParsedCommand): string | undefined {
  const flagReason = typeof parsed.flags.reason === 'string' ? parsed.flags.reason : undefined;
  return flagReason ?? parsed.args[0];
}

/**
 * Whether a `/dismiss` command's supplied reason is valid (or omitted).
 * A missing reason is valid and defaults to `other`; a supplied but unknown
 * value is invalid and should be surfaced to the author instead of silently
 * coerced.
 * @param parsed - The parsed slash command.
 * @returns True when no reason was supplied or it matches a known value.
 */
export function isValidDismissReason(parsed: ParsedCommand): boolean {
  const candidate = getSuppliedReason(parsed);
  return candidate === undefined || (DISMISS_REASONS as readonly string[]).includes(candidate);
}

/**
 * Build the usage reply shown when a user supplies an unknown dismissal reason.
 * @param supplied - The unrecognized reason the user supplied.
 * @returns The markdown usage body listing the valid reasons.
 */
export function buildDismissUsage(supplied?: string): string {
  const safeSupplied = supplied?.replace(/`/g, "'");
  return [
    safeSupplied
      ? `⚠️ **Unknown dismissal reason:** \`${safeSupplied}\``
      : '⚠️ **Missing dismissal reason.**',
    '',
    `Valid reasons: ${DISMISS_REASONS.map((r) => `\`${r}\``).join(', ')}`,
    '',
    'Usage: `/dismiss <reason>`',
    '',
    'Nothing was dismissed.',
  ].join('\n');
}

/**
 * Extract a structured dismissal reason from a parsed `/dismiss` command.
 * Supports both a positional argument (`/dismiss false_positive`) and an
 * explicit flag (`/dismiss --reason=intentional`). Unknown or missing reasons
 * fall back to `other`.
 * @param parsed - The parsed slash command.
 * @returns A valid dismissal reason string.
 */
export function parseDismissReason(parsed: ParsedCommand): string {
  const candidate = getSuppliedReason(parsed);
  return (DISMISS_REASONS as readonly string[]).includes(candidate ?? '')
    ? (candidate as string)
    : DEFAULT_DISMISS_REASON;
}

/** Maximum number of findings fetched when correlating a dismissed comment. */
const MAX_FINDINGS = 1000;

/** Minimum first-sentence length (chars) trusted for dismissal body matching. */
const MIN_SENTENCE_MATCH_LENGTH = 24;

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
 * Dismissal is GitHub-only and restricted to privileged commenters (owner,
 * member, or collaborator) — it mutates the shared learning store and hides
 * bot comments, so both checks are enforced here as a defense-in-depth backstop
 * for direct callers.
 *
 * @param prNumber - PR number.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param store - Learning store used to persist dismissal feedback.
 * @param parentCommentId - ID of the bot comment being dismissed (the reply's `in_reply_to_id`).
 * @param parsed - The parsed `/dismiss` command.
 * @param authorAssociation - The dismissing user's GitHub `author_association`.
 * @param signal - Optional AbortSignal to cancel underlying API requests.
 */
export async function handleDismissCommand(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  store: LearningStore,
  parentCommentId: number,
  parsed: ParsedCommand,
  authorAssociation?: string,
  signal?: AbortSignal,
): Promise<void> {
  const logger = new Logger('Dismiss', { repo, prNumber });

  // Dismissal relies on review threads, comment minimization, and bot-thread
  // lookups that only the GitHub adapter implements; the subscriber only
  // listens to GitHub's review_comment.created webhook.
  if (config.platform === 'gitlab') {
    logger.info('Dismiss command is only supported on GitHub — skipping');
    return;
  }

  if (!isPrivilegedAuthor(authorAssociation)) {
    logger.info(
      `Author association "${authorAssociation || 'none'}" is not privileged — skipping dismissal`,
    );
    return;
  }

  const gh: PlatformAdapter = createPlatformAdapter(token, repo, config.platform);
  const reason = parseDismissReason(parsed);

  try {
    const thread = await gh.getReviewCommentThread(parentCommentId, prNumber, signal);

    const parentComment = thread.comments.find((c) => c.id === parentCommentId);
    if (!parentComment || !parentComment.isBot) {
      logger.info(`Comment ${parentCommentId} is not from the bot — skipping dismissal`);
      return;
    }

    if (!isValidDismissReason(parsed)) {
      const supplied = getSuppliedReason(parsed);
      logger.info(
        `Invalid dismissal reason "${supplied ?? ''}" — replying with usage and recording nothing`,
      );
      try {
        await gh.replyToReviewComment(prNumber, parentCommentId, buildDismissUsage(supplied));
      } catch (err) {
        logger.warn(
          `Failed to post dismiss usage reply: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    let matched: Array<{ id: string }> = [];
    try {
      const findings = await store.getFindings(prNumber, MAX_FINDINGS);

      // Prefer exact correlation: findings expose the review comment they were
      // posted from (comment_id), so match it directly against the dismissed
      // comment instead of inferring from file/line coincidence.
      const exactMatches = findings.filter(
        (f) => typeof f.comment_id === 'number' && f.comment_id === parentCommentId,
      );

      if (exactMatches.length > 0) {
        matched = exactMatches;
      } else if (thread.filePath && thread.lineNumber !== undefined) {
        // Fallback to precise file/line correlation only when the thread
        // carries a concrete anchor. Path-less or line-less (thread-level)
        // comments must never match every finding for the PR — that would
        // record dismissal feedback against findings the user never dismissed.
        matched = findings.filter(
          (f) =>
            f.id &&
            typeof f.id === 'string' &&
            typeof f.file === 'string' &&
            f.file === thread.filePath &&
            typeof f.line === 'number' &&
            f.line === thread.lineNumber,
        );
      } else if (parentComment.body) {
        // Thread-level / general comments carry no path/line. Correlate by the
        // comment body: the bot quotes the finding message (or its essence) in
        // the comment, so match findings whose message text appears in the
        // comment. This keeps dismissal feedback scoped to the actual finding
        // instead of silently dropping it (the previous no-op) or over-matching
        // the whole PR.
        const normalizedBody = parentComment.body.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
        const matchBy = (sentenceOnly: boolean) =>
          findings.filter((f) => {
            if (!f.id || typeof f.message !== 'string' || !f.message) return false;
            const normalizedMsg = f.message
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, ' ')
              .trim();
            if (!normalizedMsg) return false;
            if (sentenceOnly) {
              // Prefer the first meaningful sentence of the message for a stable match.
              const firstSentence = normalizedMsg.split(/\s{2,}|\.\s/)[0];
              return (
                firstSentence.length >= MIN_SENTENCE_MATCH_LENGTH &&
                normalizedBody.includes(firstSentence)
              );
            }
            return normalizedBody.includes(normalizedMsg);
          });
        // A first-sentence match is only trusted when it identifies exactly one
        // finding: two findings sharing a sentence would otherwise BOTH receive
        // the dismissal feedback for a single comment. Otherwise require exactly
        // one full-message match; ambiguous matches record nothing.
        const sentenceMatches = matchBy(true);
        if (sentenceMatches.length === 1) {
          matched = sentenceMatches;
        } else {
          const fullMatches = matchBy(false);
          if (fullMatches.length === 1) matched = fullMatches;
        }
        if (matched.length === 0) {
          // Last resort for thread-level dismissal: record a PR-scoped signal so
          // at least the suppression aggregation can group by message text. Must
          // also identify exactly one finding to avoid ambiguous feedback.
          const lastResort = findings.filter(
            (f) =>
              f.id &&
              typeof f.message === 'string' &&
              normalizedBody.includes(f.message.toLowerCase()),
          );
          if (lastResort.length === 1) matched = lastResort;
        }
      }
    } catch (err) {
      logger.warn(
        `Failed to fetch findings for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (matched.length === 0) {
      logger.info(`No findings matched dismissed comment ${parentCommentId} — nothing recorded`);
      // Silence here looks like success: the user believes the feedback was
      // recorded even though nothing was stored and nothing was minimized.
      try {
        await gh.replyToReviewComment(
          prNumber,
          parentCommentId,
          '⚠️ **Could not match this comment to a recorded finding** — nothing was dismissed. Try dismissing from the review thread that contains the finding.',
        );
      } catch (err) {
        logger.warn(
          `Failed to post dismiss no-match reply: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    let recorded = false;
    try {
      await store.recordFeedbackBatch(
        matched.map((f) => ({
          findingId: f.id,
          signalType: 'dismissed' as const,
          signalValue: reason,
          prNumber,
        })),
      );
      recorded = true;
      logger.info(
        `Recorded dismissal feedback for ${matched.length} finding(s) with reason "${reason}"`,
      );
    } catch (err) {
      logger.warn(
        `Failed to record dismissal feedback: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Only minimize and acknowledge when feedback was actually persisted;
    // otherwise the ack would claim a record that does not exist.
    if (!recorded) return;

    try {
      const botThreads = await gh.getBotReviewThreads(prNumber);
      const match = (botThreads ?? []).find((t) => t.firstComment.databaseId === parentCommentId);
      if (match) {
        await gh.minimizeReviewComment(match.firstComment.commentId, 'RESOLVED');
        logger.info(`Minimized bot review comment ${parentCommentId}`);
      } else {
        logger.warn(
          `Feedback recorded for comment ${parentCommentId} but no bot thread matched — comment not minimized`,
        );
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
