import type { FailOnSeverity } from '../types/index.js';

/** Stats slice used by the severity-threshold logic (shared by the Action and App review paths). */
export interface SeverityStats {
  critical: number;
  important: number;
  minor: number;
}

/**
 * Count findings at or above a severity threshold. Higher-severity findings
 * always count towards lower thresholds, so 'important' includes criticals and
 * 'minor' includes everything.
 * @param stats - Finding counts by severity.
 * @param threshold - Threshold (never 'off'; the caller guards that case).
 * @returns The number of findings at or above the threshold.
 */
export function countAtOrAboveSeverity(
  stats: SeverityStats,
  threshold: Exclude<FailOnSeverity, 'off'>,
): number {
  switch (threshold) {
    case 'critical':
      return stats.critical;
    case 'important':
      return stats.critical + stats.important;
    case 'minor':
      return stats.critical + stats.important + stats.minor;
    default:
      throw new Error(`Unknown fail-on severity threshold: ${String(threshold)}`);
  }
}

/**
 * Decide whether a review/audit result should fail the action or check run
 * based on a severity threshold. `'off'` never fails from findings (preserving
 * the pre-integration behavior).
 * @param stats - Finding counts by severity.
 * @param threshold - Severity threshold (default 'off').
 * @returns True when at least one finding is at or above the threshold.
 */
export function shouldFailOnSeverity(stats: SeverityStats, threshold: FailOnSeverity): boolean {
  if (threshold === 'off') return false;
  return countAtOrAboveSeverity(stats, threshold) > 0;
}
