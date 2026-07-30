import type { PreviousFindingIteration, ReviewIssue, ReviewResult } from '../types/index.js';
import type { GitHubHelper } from './github.js';

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
 * Build the autofix review status body for a PR comment.
 * @param history - The iteration history records.
 * @param maxIterations - Maximum allowed iterations.
 * @param phase - Current review phase.
 * @param current - Optional current review result.
 * @returns A markdown string with the review status and issue summary.
 */
export function buildReviewBody(
  history: IterationRecord[],
  maxIterations: number,
  phase: 'reviewing' | 'approved' | 'no-changes' | 'max-iterations',
  current?: ReviewResult,
): string {
  const lines: string[] = ['## 🤖 Autofix Review', ''];
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
        lines.push(`- **${i.severity.toUpperCase()}:** \`${i.file}:${i.line}\` — ${i.message}`);
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
  const lines: string[] = ['## 🔧 Autofix Applied', ''];
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
  const lines: string[] = ['## ✅ Ready to Merge', ''];
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
 * @param gh - GitHub helper instance.
 * @param prNumber - PR number.
 * @param previousFindings - Previous iteration findings with comment IDs.
 * @param currentIssues - Issues from the current review iteration.
 * @param logger - Optional logger instance.
 * @param logger.info - Logger info method.
 * @param logger.warn - Logger warn method.
 */
export async function resolveFixedComments(
  gh: GitHubHelper,
  prNumber: number,
  previousFindings: PreviousFindingIteration[],
  currentIssues: ReviewIssue[],
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  if (previousFindings.length === 0) return;

  const lastIteration = previousFindings[previousFindings.length - 1];
  if (!lastIteration.commentIds || lastIteration.commentIds.length === 0) return;

  const stillOpenKeys = new Set(currentIssues.map((issue) => `${issue.file}:${issue.line}`));

  let threads: Awaited<ReturnType<typeof gh.getReviewThreads>> | undefined;

  for (const prevComment of lastIteration.commentIds) {
    const key = `${prevComment.file}:${prevComment.line}`;

    if (!stillOpenKeys.has(key)) {
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
