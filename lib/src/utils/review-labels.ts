import type { PlatformAdapter } from '../platform/adapter.js';
import type { ChangedFile, ReviewResult } from '../types/index.js';
import { Logger } from './logger.js';

/**
 * Native PR labels for LLM risk score and review-time estimate (Qodo parity).
 *
 * Both label families are optional, additive, and fail-open: mappers are pure
 * and dependency-free, and {@link applyReviewLabels} degrades gracefully when
 * model keys are absent or the labels API fails.
 *
 * @since NEXT
 */

/** Risk label applied per executive-summary risk level. */
export const RISK_LABELS = {
  low: 'risk:low',
  medium: 'risk:medium',
  high: 'risk:high',
} as const;

/** Review-time label buckets (minutes of estimated reviewer effort). */
export const REVIEW_TIME_LABELS = {
  quick: 'review-time:<15m',
  moderate: 'review-time:15-60m',
  long: 'review-time:>60m',
} as const;

/** Valid risk levels accepted by {@link mapRiskLevelToLabel}. */
export type RiskLevelInput = 'low' | 'medium' | 'high';

/**
 * Map an executive-summary risk level to its native PR label.
 * Returns `null` when absent/invalid so callers skip gracefully (no LLM call,
 * degrades gracefully when model keys are absent).
 * @param riskLevel - Risk level from `ReviewResult.executiveSummary`, if any.
 * @returns The matching `risk:*` label, or `null` to skip.
 * @since NEXT
 */
export function mapRiskLevelToLabel(riskLevel: string | undefined | null): string | null {
  if (riskLevel === 'low' || riskLevel === 'medium' || riskLevel === 'high') {
    return RISK_LABELS[riskLevel as RiskLevelInput];
  }
  return null;
}

/**
 * Deterministically estimate reviewer effort in minutes from diff size and
 * finding severity. Heuristic only — no LLM call, no `ReviewResult` schema
 * change. Weighted so severity (critical/important findings) pushes large or
 * risky reviews into higher buckets.
 * @param changedFiles - Changed files of the PR.
 * @param stats - Finding counts (`critical`/`important` weight the estimate).
 * @returns Estimated review minutes (>= 1).
 * @since NEXT
 */
export function estimateReviewMinutes(
  changedFiles: ChangedFile[] | undefined | null,
  stats?: { critical?: number; important?: number } | undefined | null,
): number {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  let totalLines = 0;
  for (const f of files) {
    const additions = typeof f?.additions === 'number' && f.additions > 0 ? f.additions : 0;
    const deletions = typeof f?.deletions === 'number' && f.deletions > 0 ? f.deletions : 0;
    totalLines += additions + deletions;
  }
  const critical = typeof stats?.critical === 'number' && stats.critical > 0 ? stats.critical : 0;
  const important =
    typeof stats?.important === 'number' && stats.important > 0 ? stats.important : 0;
  const minutes = Math.ceil(totalLines / 100) + files.length + critical * 5 + important * 2;
  return Math.max(1, minutes);
}

/**
 * Map estimated review minutes to its native PR label bucket.
 * @param minutes - Estimated reviewer effort in minutes.
 * @returns The matching `review-time:*` label, or `null` for invalid input.
 * @since NEXT
 */
export function mapMinutesToLabel(minutes: number | undefined | null): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 15) return REVIEW_TIME_LABELS.quick;
  if (minutes <= 60) return REVIEW_TIME_LABELS.moderate;
  return REVIEW_TIME_LABELS.long;
}

/**
 * Collect the risk + review-time labels to apply for a completed review.
 * Pure helper (no I/O) so it is trivially unit-testable.
 * @param pr - PR context carrying `changedFiles`.
 * @param result - Completed review result (`executiveSummary` + `stats`).
 * @param flags - Opt-in flags gating each label family (default off).
 * @returns De-duplicated labels to apply (0-2 entries).
 * @since NEXT
 */
export function collectReviewLabels(
  pr: { changedFiles?: ChangedFile[] | null } | undefined | null,
  result: ReviewResult | undefined | null,
  flags: { applyRiskLabels?: boolean; applyReviewTimeLabels?: boolean },
): string[] {
  const labels: string[] = [];
  if (!result || result.skipped) return labels;
  if (flags.applyRiskLabels) {
    const riskLabel = mapRiskLevelToLabel(result.executiveSummary?.riskLevel);
    if (riskLabel) labels.push(riskLabel);
  }
  if (flags.applyReviewTimeLabels) {
    const timeLabel = mapMinutesToLabel(
      estimateReviewMinutes(pr?.changedFiles ?? [], result.stats),
    );
    if (timeLabel) labels.push(timeLabel);
  }
  return [...new Set(labels)];
}

/**
 * Apply optional risk + review-time native PR labels after a review completes.
 *
 * Additive, guarded, fail-open: skipped entirely when both flags are off or
 * the review was skipped; at most 2 label API calls (`ensureLabels` +
 * `addLabels`); any API failure (or missing permissions) logs a warning and
 * the review still posts.
 * @param adapter - Platform adapter exposing `ensureLabels`/`addLabels`.
 * @param prNumber - PR number to label.
 * @param pr - PR context carrying `changedFiles`.
 * @param result - Completed review result (`executiveSummary` + `stats`).
 * @param flags - Opt-in flags gating each label family (default off).
 * @since NEXT
 */
export async function applyReviewLabels(
  adapter: Pick<PlatformAdapter, 'ensureLabels' | 'addLabels'>,
  prNumber: number,
  pr: { changedFiles?: ChangedFile[] | null } | undefined | null,
  result: ReviewResult | undefined | null,
  flags: { applyRiskLabels?: boolean; applyReviewTimeLabels?: boolean },
): Promise<void> {
  if (!flags.applyRiskLabels && !flags.applyReviewTimeLabels) return;
  const labels = collectReviewLabels(pr, result, flags);
  if (labels.length === 0) return;
  const logger = new Logger('ReviewLabels', { prNumber });
  try {
    await adapter.ensureLabels(labels);
    await adapter.addLabels(prNumber, labels);
    logger.info(`Applied review labels: ${labels.join(', ')}`);
  } catch (err) {
    logger.warn(
      `Failed to apply review labels, continuing review: ${err instanceof Error ? err.message : String(err)}`,
      { operation: 'review.labels', prNumber },
    );
  }
}
