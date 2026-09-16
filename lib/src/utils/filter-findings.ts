import { minimatch } from 'minimatch';
import type {
  CategoryOverride,
  ConfidenceThreshold,
  MinSeverity,
  ReviewIssue,
  ReviewPreset,
  Severity,
  SeverityGate,
} from '../types/index.js';

/** Rank of each existing Severity value on the shared severity scale. */
const SEVERITY_RANK: Record<Severity, number> = {
  minor: 1,
  important: 2,
  critical: 3,
};

/** Rank of each confidence value on the shared confidence scale. */
const CONFIDENCE_RANK: Record<'high' | 'medium' | 'low', number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Map a config-side `minSeverity` floor to the existing severity rank scale.
 * The config enum is a *floor* over the existing three-tier ordering
 * (`critical > important > minor`): 'warning' keeps everything, 'error' drops
 * minor findings, 'critical' keeps only critical findings.
 *
 * @param minSeverity - Config minSeverity floor, or undefined (default 'warning').
 * @returns The minimum rank to keep.
 */
export function minSeverityRank(minSeverity?: MinSeverity): number {
  switch (minSeverity) {
    case 'critical':
      return 3;
    case 'error':
      return 2;
    case 'warning':
      return 1;
    default:
      return 1;
  }
}

/**
 * Rank an existing `Severity` value on the shared severity scale.
 * @param severity - Severity of a finding.
 * @returns The rank (1 = minor, 2 = important, 3 = critical).
 */
export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity] ?? 1;
}

/**
 * Map a config-side `confidenceThreshold` floor to the confidence rank scale.
 * 'low' keeps everything, 'medium' drops low-confidence findings, 'high' keeps
 * only high-confidence findings.
 *
 * @param threshold - Config confidence floor, or undefined (default 'low').
 * @returns The minimum confidence rank to keep.
 */
export function confidenceThresholdRank(threshold?: ConfidenceThreshold): number {
  return threshold ? (CONFIDENCE_RANK[threshold] ?? 1) : 1;
}

/** Options controlling how findings are filtered. */
export interface FilterFindingsOptions {
  /** Global minimum severity floor ('warning' | 'error' | 'critical'). */
  minSeverity?: MinSeverity;
  /** Additional global severity floor expressed as a rank; maxed with `minSeverity`. */
  minSeverityRankValue?: number;
  /** Global confidence floor ('low' | 'medium' | 'high'). */
  confidenceThreshold?: ConfidenceThreshold;
  /** Maximum findings kept per category (undefined = unlimited). */
  maxFindingsPerCategory?: number;
  /** Maximum total findings kept (undefined = unlimited). */
  maxTotalFindings?: number;
  /** If set, only findings whose category matches one of these are kept. */
  focusAreas?: string[];
  /** Glob patterns applied to finding file paths. */
  ignorePatterns?: string[];
  /** Per-category overrides keyed by category name. */
  categories?: Record<string, CategoryOverride>;
  /** Category to assign to findings without one (default 'general'). */
  defaultCategory?: string;
  /**
   * Quiet-mode severity gate. `'blocking-only'` keeps only `critical`
   * findings plus security-tagged findings (`category === 'security'`,
   * case-insensitive); findings with a missing severity are kept
   * (fail-open). Absent or `'all'` preserves legacy behavior. AND-composed
   * with (never loosening) the existing minSeverity/confidence/caps pipeline.
   * @since NEXT
   */
  severityGate?: SeverityGate;
  /**
   * Noise preset. `'chill'` suppresses low-signal nitpicks: drops `minor`
   * findings and `style`-category findings (case-insensitive) and raises the
   * effective confidence floor to at least `medium`. Pure local filter, no
   * model change. Absent or `'default'` preserves legacy behavior.
   * @since NEXT
   */
  reviewPreset?: ReviewPreset;
}

/** Result of a filtering pass over review findings. */
export interface FilterFindingsResult {
  /** Findings that survived filtering (category always populated). */
  issues: ReviewIssue[];
  /** Number of findings dropped by the filter. */
  dropped: number;
}

function sortBySeverity(issues: ReviewIssue[]): ReviewIssue[] {
  return [...issues].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

/**
 * Filter review findings against the configured sensitivity settings.
 *
 * Applies, in order: per-category `enabled: false` and category overrides,
 * `focusAreas` allowlist, `ignorePatterns` file globs, the `blocking-only`
 * severity gate and `chill` preset noise suppression (both AND-composed, never
 * loosening), global/per-category severity floor, confidence floor
 * (`chill` raises the effective floor to at least `medium`), per-category
 * finding cap, then the total finding cap (keeping the highest-severity
 * findings).
 *
 * @param issues - Raw findings from the model (after verification/reachability).
 * @param options - Sensitivity configuration to apply.
 * @returns Filtered findings with recomputed count of dropped findings.
 */
export function filterFindings(
  issues: ReviewIssue[],
  options: FilterFindingsOptions,
): FilterFindingsResult {
  const defaultCategory = options.defaultCategory ?? 'general';
  const baseMinRank = minSeverityRank(options.minSeverity);
  const globalMinRank =
    options.minSeverityRankValue !== undefined
      ? Math.max(baseMinRank, options.minSeverityRankValue)
      : baseMinRank;
  // `chill` is a pure-local preset: raise the effective confidence floor to at
  // least `medium` (never loosening an explicitly stricter `high` floor).
  const isChill = options.reviewPreset === 'chill';
  const effectiveConfidenceThreshold =
    isChill && options.confidenceThreshold !== 'high' ? 'medium' : options.confidenceThreshold;
  const globalConfidenceRank = confidenceThresholdRank(effectiveConfidenceThreshold);
  const isBlockingOnly = options.severityGate === 'blocking-only';
  const ignorePatterns = options.ignorePatterns ?? [];
  const focusAreas = options.focusAreas ?? [];
  const categories = options.categories ?? {};

  let remaining: ReviewIssue[] = [];

  for (const issue of issues) {
    const category = issue.category ?? defaultCategory;
    const override = categories[category];

    if (override?.enabled === false) continue;
    if (focusAreas.length > 0 && !focusAreas.includes(category)) continue;
    if (issue.file && ignorePatterns.some((pattern) => minimatch(issue.file, pattern))) continue;

    // Blocking-only gate (fail-open): keep critical findings and
    // security-tagged findings; a missing severity is kept rather than
    // dropped. AND-composed with every other check below.
    if (isBlockingOnly && issue.severity !== undefined) {
      const categoryLower = category.toLowerCase();
      if (issue.severity !== 'critical' && categoryLower !== 'security') continue;
    }

    // Chill preset noise suppression: drop minor-severity nitpicks and
    // style-category nitpicks (case-insensitive).
    if (isChill) {
      if (issue.severity === 'minor') continue;
      if (category.toLowerCase() === 'style') continue;
    }

    // Per-category overrides only tighten the effective floor; they can never
    // loosen a global/audit severity floor (e.g. the audit issueSeverityThreshold).
    const overrideMinRank =
      override?.minSeverity !== undefined ? minSeverityRank(override.minSeverity) : undefined;
    const minRank =
      overrideMinRank !== undefined ? Math.max(overrideMinRank, globalMinRank) : globalMinRank;
    if (severityRank(issue.severity) < minRank) continue;

    // A missing confidence is treated as 'low' (rank 1) so a confidence floor
    // above 'low' is actually enforced even when the model omits the field.
    const confidenceRank = issue.confidence ? confidenceThresholdRank(issue.confidence) : 1;
    if (confidenceRank < globalConfidenceRank) {
      continue;
    }

    remaining.push({ ...issue, category });
  }

  const hasPerCategoryCap = Object.values(categories).some((c) => c?.maxFindings !== undefined);
  if (options.maxFindingsPerCategory !== undefined || hasPerCategoryCap) {
    const byCategory = new Map<string, ReviewIssue[]>();
    for (const issue of remaining) {
      const category = issue.category ?? defaultCategory;
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category)!.push(issue);
    }
    const kept: ReviewIssue[] = [];
    for (const [category, categoryIssues] of byCategory) {
      const cap = categories[category]?.maxFindings ?? options.maxFindingsPerCategory;
      kept.push(...sortBySeverity(categoryIssues).slice(0, cap));
    }
    remaining = kept;
  }

  if (options.maxTotalFindings !== undefined && remaining.length > options.maxTotalFindings) {
    remaining = sortBySeverity(remaining).slice(0, options.maxTotalFindings);
  }

  return { issues: remaining, dropped: issues.length - remaining.length };
}

/**
 * Recompute the severity/confidence summary stats for a set of findings.
 * Kept in sync with the parsing pipeline so filtered results report accurate counts.
 *
 * @param issues - Findings to summarize.
 * @returns Stats matching the ReviewResult.stats shape.
 */
export function computeReviewStats(issues: ReviewIssue[]): {
  total: number;
  critical: number;
  important: number;
  minor: number;
  highConfidence?: number;
  mediumConfidence?: number;
  lowConfidence?: number;
} {
  const stats = issues.reduce(
    (acc, i) => {
      if (i.severity === 'critical') acc.critical++;
      else if (i.severity === 'important') acc.important++;
      else if (i.severity === 'minor') acc.minor++;
      if (i.confidence === 'high') acc.highConfidence++;
      else if (i.confidence === 'medium') acc.mediumConfidence++;
      else if (i.confidence === 'low') acc.lowConfidence++;
      return acc;
    },
    {
      critical: 0,
      important: 0,
      minor: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
    },
  );
  return {
    total: issues.length,
    critical: stats.critical,
    important: stats.important,
    minor: stats.minor,
    ...(stats.highConfidence > 0 && { highConfidence: stats.highConfidence }),
    ...(stats.mediumConfidence > 0 && { mediumConfidence: stats.mediumConfidence }),
    ...(stats.lowConfidence > 0 && { lowConfidence: stats.lowConfidence }),
  };
}
