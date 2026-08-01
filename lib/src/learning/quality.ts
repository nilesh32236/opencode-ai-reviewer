import type { ReviewQualityRow } from './types.js';

/**
 * SQL fragment matching rows that carry at least one positive quality score.
 * Zero-score rows are telemetry-only (pipeline stages with no quality
 * assessment) and must be excluded from quality averages while still counting
 * toward token/latency aggregates. Shared by the SQLite adapter so the filter
 * stays consistent across every metrics path.
 */
export const QUALITY_SCORE_SQL_FRAGMENT =
  'actionability_score > 0 OR accuracy_score > 0 OR coverage_score > 0 OR consistency_score > 0';

/**
 * Whether a review quality row carries at least one positive score.
 * Rows written purely for duration/token telemetry (e.g. by the
 * TelemetrySubscriber) have all scores set to 0 and should be excluded from
 * quality averages but included in token/latency metrics.
 * @param row - The review quality row to inspect.
 * @returns True when at least one score column is greater than zero.
 */
export function hasQualityScore(
  row: Pick<
    ReviewQualityRow,
    'actionability_score' | 'accuracy_score' | 'coverage_score' | 'consistency_score'
  >,
): boolean {
  return (
    row.actionability_score > 0 ||
    row.accuracy_score > 0 ||
    row.coverage_score > 0 ||
    row.consistency_score > 0
  );
}
