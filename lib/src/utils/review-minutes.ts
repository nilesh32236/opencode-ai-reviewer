import type { ChangedFile, ReviewIssue } from '../types/index.js';

/** Upper bound for the review-effort minutes estimate (minutes). */
export const MAX_REVIEW_MINUTES = 120;

/** Lines of churn (additions + deletions) covered per estimated minute. */
export const REVIEW_MINUTES_LINES_PER_MINUTE = 120;

/**
 * Minimal churn shape accepted by {@link estimateReviewMinutes}. A subset of
 * `ChangedFile` so callers with partial diff stats can still estimate.
 */
export interface ReviewMinutesChangedFile {
  /** Number of added lines (non-negative finite number). */
  additions?: unknown;
  /** Number of deleted lines (non-negative finite number). */
  deletions?: unknown;
}

/**
 * Estimate reviewer effort in whole minutes from diff churn and finding
 * counts. Pure and dependency-free: no model call, no extra queries.
 *
 * Heuristic: `ceil(changedLines / 120 + critical * 4 + important * 2 +
 * minor * 0.5)`, clamped to 1–120. Returns `undefined` when there is no
 * usable signal (no files/churn and no issues) so callers can omit the line
 * (fail-open).
 * @param changedFiles - Changed files with `additions`/`deletions` stats.
 * @param issues - Review findings contributing severity weights.
 * @returns Whole minutes in [1, 120], or `undefined` when uncomputable.
 * @since NEXT
 */
export function estimateReviewMinutes(
  changedFiles?: Array<ChangedFile | ReviewMinutesChangedFile> | null,
  issues?: ReviewIssue[] | null,
): number | undefined {
  try {
    let changedLines = 0;
    let hasChurnSignal = false;
    if (Array.isArray(changedFiles)) {
      for (const f of changedFiles) {
        const additions =
          typeof (f as ChangedFile)?.additions === 'number' &&
          Number.isFinite((f as ChangedFile).additions) &&
          (f as ChangedFile).additions > 0
            ? (f as ChangedFile).additions
            : 0;
        const deletions =
          typeof (f as ChangedFile)?.deletions === 'number' &&
          Number.isFinite((f as ChangedFile).deletions) &&
          (f as ChangedFile).deletions > 0
            ? (f as ChangedFile).deletions
            : 0;
        if (additions > 0 || deletions > 0) hasChurnSignal = true;
        changedLines += additions + deletions;
      }
      // Non-empty file list with zero churn still counts as a (trivial)
      // signal so tiny PRs estimate 1 min instead of omitting the line.
      if (changedFiles.length > 0) hasChurnSignal = true;
    }
    let critical = 0;
    let important = 0;
    let minor = 0;
    let hasIssueSignal = false;
    if (Array.isArray(issues) && issues.length > 0) {
      hasIssueSignal = true;
      for (const issue of issues) {
        if (issue?.severity === 'critical') critical += 1;
        else if (issue?.severity === 'important') important += 1;
        else if (issue?.severity === 'minor') minor += 1;
      }
    }
    if (!hasChurnSignal && !hasIssueSignal) return undefined;
    const raw =
      changedLines / REVIEW_MINUTES_LINES_PER_MINUTE + critical * 4 + important * 2 + minor * 0.5;
    const minutes = Math.ceil(raw);
    if (!Number.isFinite(minutes)) return undefined;
    return Math.min(Math.max(minutes, 1), MAX_REVIEW_MINUTES);
  } catch {
    return undefined;
  }
}

/**
 * Format an estimated minutes value as a single review-body markdown line.
 * @param minutes - Whole minutes (must be a positive finite number).
 * @returns Markdown line like `**Review effort:** ~N min`, or '' when invalid.
 * @since NEXT
 */
export function formatEffortMinutesLine(minutes: number | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return '';
  return `**Review effort:** ~${Math.round(minutes)} min`;
}

/**
 * Static author self-review checklist markdown (no state dependency).
 * @returns The checklist line.
 * @since NEXT
 */
export function formatSelfReviewChecklist(): string {
  return '- [ ] Author self-review: I checked obvious issues (tests, lint, secrets) before requesting review.';
}
