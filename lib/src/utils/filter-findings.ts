import { minimatch } from 'minimatch';
import type {
  CategoryOverride,
  ConfidenceThreshold,
  MinSeverity,
  ReviewIssue,
  Severity,
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
}

/** Options controlling the severity-ordered inline noise budget.
 * @since NEXT
 */
export interface NoiseBudgetOptions {
  /** Maximum findings posted inline (severity-ordered, highest first). */
  maxInline?: number;
  /** When false, overflow is truncated (legacy); when true/absent it spills to `spilled`. */
  spilloverToSummary?: boolean;
}

/** Result of applying the inline noise budget to review findings.
 * @since NEXT
 */
export interface NoiseBudgetResult {
  /** Findings kept for inline posting (severity-ordered, highest first). */
  inline: ReviewIssue[];
  /** Overflow beyond `maxInline` for the summary body (severity-ordered). Empty when no cap applies. */
  spilled: ReviewIssue[];
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
 * `focusAreas` allowlist, `ignorePatterns` file globs, global/per-category
 * severity floor, confidence floor, per-category finding cap, then the total
 * finding cap (keeping the highest-severity findings).
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
  const globalConfidenceRank = confidenceThresholdRank(options.confidenceThreshold);
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
 * Apply the severity-ordered inline noise budget to review findings.
 *
 * Pure, stable, and fail-open: when `maxInline` is absent, non-finite, or
 * non-positive the input is returned untouched (`{ inline: issues,
 * spilled: [] }`, same array reference — legacy behavior). Otherwise the
 * findings are severity-ordered (critical > important > minor, stable for
 * ties so criticals never sort below minors) and split into the first
 * `maxInline` inline findings plus the `spilled` overflow. When
 * `spilloverToSummary === false` the overflow is truncated (legacy drop)
 * instead of spilled.
 *
 * @param issues - Findings to budget (already sensitivity-filtered).
 * @param options - Noise-budget configuration to apply.
 * @returns Inline findings plus spilled overflow for the summary body.
 * @since NEXT
 */
export function applyNoiseBudget(
  issues: ReviewIssue[],
  options?: NoiseBudgetOptions,
): NoiseBudgetResult {
  const maxInline = options?.maxInline;
  if (maxInline === undefined || !Number.isFinite(maxInline) || Math.round(maxInline) < 1) {
    return { inline: issues, spilled: [] };
  }
  const cap = Math.min(Math.round(maxInline), 500);
  if (issues.length <= cap) {
    return { inline: issues, spilled: [] };
  }
  const sorted = sortBySeverity(issues);
  const inline = sorted.slice(0, cap);
  if (options?.spilloverToSummary === false) {
    return { inline, spilled: [] };
  }
  return { inline, spilled: sorted.slice(cap) };
}

/**
 * Split a result's inline-flagged findings by the severity-ordered noise
 * budget for the posting layer.
 *
 * Pure and fail-open: without a usable `maxInline` cap the input array is
 * returned by reference with an empty `spilled` list (legacy behavior — call
 * sites stay byte-identical). Otherwise inline-flagged findings are capped
 * severity-ordered (highest first) and the overflow is returned as `spilled`
 * for the summary body, so capped findings are surfaced instead of silently
 * dropped. Non-inline findings always pass through untouched.
 *
 * @param issues - Findings to split (already deduped/filtered).
 * @param options - Noise-budget configuration to apply.
 * @returns Issues with over-budget inline findings removed, plus the spillover.
 * @since NEXT
 */
export function splitInlineByNoiseBudget(
  issues: ReviewIssue[],
  options?: NoiseBudgetOptions,
): { issues: ReviewIssue[]; spilled: ReviewIssue[] } {
  const { inline, spilled } = applyNoiseBudget(
    issues.filter((i) => i.inline === true),
    options,
  );
  if (spilled.length === 0) return { issues, spilled };
  const kept = new Set(inline);
  return {
    issues: issues.filter((i) => i.inline !== true || kept.has(i)),
    spilled,
  };
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
