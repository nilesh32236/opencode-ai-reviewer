import type { PlatformAdapter } from '../platform/adapter.js';
import type { PreviousFindingIteration, ReviewIssue, ReviewResult } from '../types/index.js';
import { formatIssueBullet } from './review-body.js';

/** Record of a single auto-fix iteration. */
export interface IterationRecord {
  iteration: number;
  status: 'approved' | 'fix-applied' | 'needs-fix' | 'no-changes' | 'timeout';
  summary: string;
  critical: number;
  important: number;
  minor: number;
  filesChanged?: string[];
  commitMessage?: string;
  fixSummary?: string;
}

export const REVIEW_MARKER = '<!-- autofix-review -->';
export const FIX_MARKER = '<!-- autofix-applied -->';

/**
 * Build the Markdown status body for an autofix run, summarizing the iteration
 * history and, when a current review result is supplied, its issues and strengths.
 * The `phase` argument drives the status line: 'reviewing' (in progress),
 * 'approved', 'no-changes', or 'max-iterations' (manual review required).
 * @param history - The iteration history records.
 * @param maxIterations - Maximum allowed iterations.
 * @param phase - Current review phase.
 * @param current - Optional current review result.
 * @returns A markdown string with the review status and issue summary.
 */
export function buildAutofixStatusBody(
  history: IterationRecord[],
  maxIterations: number,
  phase: 'reviewing' | 'approved' | 'no-changes' | 'max-iterations',
  current?: ReviewResult,
): string {
  const lines: string[] = ['## Autofix Review 🤖', ''];
  const currentIter = history.length;

  switch (phase) {
    case 'reviewing':
      lines.push(`**Status:** 🔍 Reviewing (iteration ${currentIter}/${maxIterations})`);
      break;
    case 'approved':
      lines.push('**Status:** ✅ Approved — all issues resolved');
      break;
    case 'no-changes':
      lines.push(
        `**Status:** ℹ️ Fix agent made no changes (iteration ${currentIter}/${maxIterations})`,
      );
      break;
    case 'max-iterations':
      lines.push('**Status:** ⚠️ Manual review required');
      break;
  }

  if (current) {
    if (current.summary) lines.push('', '### Summary', '', current.summary);
    if (current.issues.length > 0) {
      lines.push('', '### Issues Found');
      for (const i of current.issues) {
        lines.push(formatIssueBullet(i));
        if (i.suggestion) {
          lines.push(`  > 💡 **How to fix:** ${i.suggestion}`);
        }
        if (i.suggestionCode) {
          lines.push('<details><summary>Show suggested fix</summary>');
          lines.push('');
          lines.push('```suggestion');
          lines.push(i.suggestionCode.trim());
          lines.push('```');
          lines.push('</details>');
        }
      }
    }
    if (current.strengths.length > 0) {
      lines.push('', '### Strengths');
      for (const s of current.strengths) {
        lines.push(`- ✅ **${s.file}:${s.line}** — ${s.message}`);
      }
    }
  }

  if (history.length > 0) {
    lines.push('', '### Iteration History');
    for (const h of history) {
      let icon: string;
      let detail: string;
      switch (h.status) {
        case 'approved':
          icon = '✅';
          detail = 'All issues resolved';
          break;
        case 'fix-applied':
          icon = '🔧';
          detail = `Fix applied — ${h.critical} critical, ${h.important} important`;
          break;
        case 'needs-fix':
          icon = '❌';
          detail = `${h.critical} critical, ${h.important} important remaining`;
          break;
        case 'no-changes':
          icon = 'ℹ️';
          detail = 'No changes made';
          break;
        case 'timeout':
          icon = '⚠️';
          detail = 'Timed out — changes partially applied';
          break;
      }
      lines.push(`- ${icon} **Iteration ${h.iteration}:** ${detail}`);
    }
  }

  switch (phase) {
    case 'approved':
      lines.push('', '✅ **Ready to merge!**');
      break;
    case 'max-iterations':
      lines.push(
        '',
        `⚠️ **Max iterations reached (${maxIterations}).** This PR needs manual review.`,
      );
      break;
  }

  return lines.join('\n');
}

/**
 * Build the fix applied notification body for a PR comment.
 * @param history - The iteration history records.
 * @returns A markdown string describing the applied fix.
 */
export function buildFixBody(history: IterationRecord[]): string {
  const last = history[history.length - 1];
  const lines: string[] = ['## Autofix Applied 🔧', ''];
  if (last) {
    lines.push(`**Iteration:** ${last.iteration}`);
    lines.push(`**Files changed:** ${last.filesChanged?.length ?? 0}`);
    if (last.commitMessage) lines.push(`**Commit:** \`${last.commitMessage}\``);
    if (last.filesChanged && last.filesChanged.length > 0) {
      lines.push('', '### Changed Files');
      for (const f of last.filesChanged) lines.push(`- \`${f}\``);
    }
    if (last.fixSummary) {
      lines.push('', '### Fix Details', '', last.fixSummary);
    }
  }
  lines.push(
    '',
    '---',
    '',
    '🤖 The fix agent has applied changes. The PR will be reviewed again on the next iteration.',
  );
  return lines.join('\n');
}

/**
 * Build the ready-to-merge notification body for a PR comment.
 * @param history - The iteration history records.
 * @param prNumber - The PR number.
 * @returns A markdown string indicating the PR is ready to merge.
 */
export function buildReadyBody(history: IterationRecord[], prNumber: number): string {
  const lines: string[] = ['## Ready to Merge ✅', ''];
  lines.push(`All issues have been resolved in PR #${prNumber}.`);
  lines.push(
    '',
    'The review agent has approved this PR. A maintainer can merge it at their discretion.',
  );
  if (history.length > 0) {
    lines.push('', '### Summary');
    const last = history[history.length - 1];
    if (last.summary) {
      lines.push('', last.summary);
    }
  }
  return lines.join('\n');
}

/**
 * Resolve review comment threads for issues that have been verified as fixed
 * in the current review iteration.
 *
 * @param gh - Platform adapter instance.
 * @param prNumber - PR number.
 * @param previousFindings - Previous iteration findings with comment IDs.
 * @param currentIssues - Issues from the current review iteration.
 * @param logger - Optional logger instance.
 * @param logger.info - Logger info method.
 * @param logger.warn - Logger warn method.
 */
export async function resolveFixedComments(
  gh: PlatformAdapter,
  prNumber: number,
  previousFindings: PreviousFindingIteration[],
  currentIssues: ReviewIssue[],
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  if (previousFindings.length === 0) return;

  const lastIteration = previousFindings[previousFindings.length - 1];
  if (!lastIteration.commentIds || lastIteration.commentIds.length === 0) return;

  // Line coordinates shift as fixes add/remove lines above the finding, so a
  // `file:line` key alone falsely resolves a moved-but-unfixed issue (and keeps
  // a stale thread for a fixed issue that happened to land on the same line).
  // Correlate by normalized message within the same file as the primary signal,
  // falling back to exact file:line only as a tie-breaker. Correlation is
  // strictly one-to-one: each current finding can keep at most one previous
  // thread open, so duplicate messages cannot hold multiple old threads open.
  //
  // Track unmatched current findings by their file:line anchor and by
  // (normalized file, normalized message) counts. Exact file:line matches are
  // consumed first; a moved finding then consumes one same-file message match.
  const currentByAnchor = new Map<string, { fileKey: string; msgKey: string }>();
  const currentByFileMessage = new Map<string, Map<string, Set<string>>>();
  for (const issue of currentIssues) {
    if (!issue.file) continue;
    const anchor = `${issue.file}:${issue.line}`;
    const fileKey = normalizeMessage(issue.file);
    const msgKey = normalizeMessage(issue.message);
    currentByAnchor.set(anchor, { fileKey, msgKey });
    let byMsg = currentByFileMessage.get(fileKey);
    if (!byMsg) {
      byMsg = new Map();
      currentByFileMessage.set(fileKey, byMsg);
    }
    let anchors = byMsg.get(msgKey);
    if (!anchors) {
      anchors = new Set();
      byMsg.set(msgKey, anchors);
    }
    anchors.add(anchor);
  }

  const consumeAnchor = (anchor: string, msgKey: string): boolean => {
    const entry = currentByAnchor.get(anchor);
    if (!entry) return false;
    // Same coordinates with a different message means the original issue is
    // gone — the exact match only counts when the message still matches.
    if (entry.msgKey !== msgKey) return false;
    currentByAnchor.delete(anchor);
    currentByFileMessage.get(entry.fileKey)?.get(entry.msgKey)?.delete(anchor);
    return true;
  };

  const consumeAnchorByLine = (anchor: string): boolean => {
    const entry = currentByAnchor.get(anchor);
    if (!entry) return false;
    currentByAnchor.delete(anchor);
    currentByFileMessage.get(entry.fileKey)?.get(entry.msgKey)?.delete(anchor);
    return true;
  };

  const consumeMessage = (fileKey: string, msgKey: string): boolean => {
    const anchors = currentByFileMessage.get(fileKey)?.get(msgKey);
    if (!anchors || anchors.size === 0) return false;
    const anchor = anchors.values().next().value as string;
    consumeAnchorByLine(anchor);
    return true;
  };

  // Map the previous iteration's comment anchors to their finding messages so a
  // comment can be checked against the current findings by content, not only by
  // coordinates.
  const prevMessageByAnchor = new Map<string, string>();
  for (const issue of lastIteration.issues) {
    if (!issue.file) continue;
    prevMessageByAnchor.set(`${issue.file}:${issue.line}`, normalizeMessage(issue.message));
  }

  let threads: Awaited<ReturnType<typeof gh.getReviewThreads>> | undefined;

  for (const prevComment of lastIteration.commentIds) {
    const anchor = `${prevComment.file}:${prevComment.line}`;
    const prevMessage = prevMessageByAnchor.get(anchor);

    // The previous finding is still present when its file:line anchor recurs
    // with the same message, or (moved findings) when one remaining same-file
    // normalized-message match can be consumed. Consuming keeps the correlation
    // one-to-one so a single current finding never keeps multiple identical
    // threads open.
    let stillOpen = false;
    if (prevMessage !== undefined) {
      stillOpen = consumeAnchor(anchor, prevMessage);
      if (!stillOpen) {
        stillOpen = consumeMessage(normalizeMessage(prevComment.file), prevMessage);
      }
    } else {
      // No message to compare — fall back to exact file:line recurrence.
      stillOpen = consumeAnchorByLine(anchor);
    }

    if (!stillOpen) {
      try {
        if (!threads) {
          threads = await gh.getReviewThreads(prNumber);
        }
        const thread = threads.find((t) => t.firstComment.databaseId === prevComment.commentId);

        if (thread && !thread.isResolved) {
          await gh.resolveReviewThread(thread.threadId);
          logger?.info(
            `Resolved thread for ${prevComment.file}:${prevComment.line} — issue verified fixed`,
          );
        }
      } catch (err) {
        logger?.warn(
          `Could not resolve thread for comment ${prevComment.commentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (prevComment.nodeId) {
          try {
            await gh.minimizeReviewComment(prevComment.nodeId, 'RESOLVED');
          } catch (minErr) {
            logger?.warn(
              `minimizeReviewComment also failed for comment ${prevComment.commentId}: ${minErr instanceof Error ? minErr.message : String(minErr)}`,
            );
          }
        }
      }
    }
  }
}

/**
 * Normalize a message or file path for fuzzy content matching.
 * @param text - Raw message or file path to normalize.
 * @returns The lowercase, punctuation-stripped, whitespace-collapsed string
 * used for fuzzy content matching.
 */
function normalizeMessage(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
