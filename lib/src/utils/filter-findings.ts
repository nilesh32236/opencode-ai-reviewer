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

/** Result of a filtering pass over review findings. */
export interface FilterFindingsResult {
  /** Findings that survived filtering (category always populated). */
  issues: ReviewIssue[];
  /** Number of findings dropped by the filter. */
  dropped: number;
  /**
   * Findings cut by the per-category / total caps, severity-ordered (lowest
   * severity first, since caps keep the most severe findings). Empty when the
   * caps cut nothing. Findings dropped by severity/confidence/focus/ignore
   * gates are NOT included — only cap spillover is tracked here.
   */
  suppressed?: ReviewIssue[];
  /** Severity-aware accounting of `suppressed`, if any. */
  spillover?: SpilloverSummary;
}

/** Severity-aware accounting for findings hidden by a noise budget cap. */
export interface SpilloverSummary {
  /** Total number of hidden findings. */
  count: number;
  /** Hidden critical findings. */
  critical: number;
  /** Hidden important findings. */
  important: number;
  /** Hidden minor findings. */
  minor: number;
}

/** Result of applying a display/post noise budget to a finding list. */
export interface NoiseBudgetResult {
  /** Findings within budget (severity-ordered, most severe first). */
  visible: ReviewIssue[];
  /** Findings cut by the budget (severity-ordered). Empty when nothing was cut. */
  suppressed: ReviewIssue[];
  /** Severity-aware accounting of the cut findings, if any. */
  spillover?: SpilloverSummary;
}

function sortBySeverity(issues: ReviewIssue[]): ReviewIssue[] {
  return [...issues].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

/** Result of applying the legacy display-layer noise budget cap. */
export interface NoiseBudgetCapResult {
  /** Top-N findings (severity then confidence) kept inline in the body. */
  inline: ReviewIssue[];
  /** Overflow findings relocated to the collapsed summary (never dropped). */
  spilled: ReviewIssue[];
}

/**
 * Apply the severity-ordered noise budget cap to already-filtered findings.
 *
 * Sorts a copy by severity rank desc, then confidence rank desc (missing
 * confidence counts as 'low'), and keeps the top N inline. Overflow moves
 * to `spilled` for the collapsed summary section — no finding is dropped.
 * Pure function with zero API calls; fail-open by design.
 *
 * @param issues - Filtered findings to cap (not mutated).
 * @param budget - Max inline findings; unset/non-finite/<=0 means no cap
 * (returns all findings inline, same array order, byte-for-byte legacy).
 * @returns Inline and spilled findings.
 * @since NEXT
 */
export function applyNoiseBudgetCap(issues: ReviewIssue[], budget?: number): NoiseBudgetCapResult {
  try {
    if (
      budget === undefined ||
      !Number.isFinite(budget) ||
      budget <= 0 ||
      issues.length <= budget
    ) {
      return { inline: issues, spilled: [] };
    }
    const sorted = [...issues].sort((a, b) => {
      const severityDiff = severityRank(b.severity) - severityRank(a.severity);
      if (severityDiff !== 0) return severityDiff;
      const aConfidence = a.confidence ? (CONFIDENCE_RANK[a.confidence] ?? 1) : 1;
      const bConfidence = b.confidence ? (CONFIDENCE_RANK[b.confidence] ?? 1) : 1;
      return bConfidence - aConfidence;
    });
    const count = Math.floor(budget);
    return { inline: sorted.slice(0, count), spilled: sorted.slice(count) };
  } catch {
    // Fail-open: keep all findings inline as today.
    return { inline: issues, spilled: [] };
  }
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
  const suppressed: ReviewIssue[] = [];
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
      const ordered = sortBySeverity(categoryIssues);
      kept.push(...ordered.slice(0, cap));
      // The cap keeps the most severe first, so the tail is the spillover
      // (lowest severity first) — record it for user-visible accounting.
      if (cap !== undefined) suppressed.push(...ordered.slice(cap));
    }
    remaining = kept;
  }

  if (options.maxTotalFindings !== undefined && remaining.length > options.maxTotalFindings) {
    const ordered = sortBySeverity(remaining);
    suppressed.push(...ordered.slice(options.maxTotalFindings));
    remaining = ordered.slice(0, options.maxTotalFindings);
  }

  const result: FilterFindingsResult = {
    issues: remaining,
    dropped: issues.length - remaining.length,
  };
  if (suppressed.length > 0) {
    result.suppressed = suppressed;
    result.spillover = computeSpilloverSummary(suppressed);
  }
  return result;
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

/**
 * Compute severity-aware spillover accounting for a set of hidden findings.
 * @param hidden - Findings cut by a cap/budget.
 * @returns Counts by severity (all zeros when `hidden` is empty).
 */
export function computeSpilloverSummary(hidden: ReviewIssue[]): SpilloverSummary {
  let critical = 0;
  let important = 0;
  let minor = 0;
  for (const issue of hidden) {
    if (issue.severity === 'critical') critical++;
    else if (issue.severity === 'important') important++;
    else minor++;
  }
  return { count: hidden.length, critical, important, minor };
}

/**
 * Merge several spillover summaries (e.g. filter-cap spillover plus a
 * display-budget tail) into one accounting object.
 * @param summaries - Summaries to merge (undefined/null entries are skipped).
 * @returns The combined summary, or undefined when everything is empty.
 */
export function mergeSpilloverSummaries(
  ...summaries: Array<SpilloverSummary | undefined | null>
): SpilloverSummary | undefined {
  let count = 0;
  let critical = 0;
  let important = 0;
  let minor = 0;
  for (const summary of summaries) {
    if (!summary || summary.count <= 0) continue;
    count += summary.count;
    critical += summary.critical;
    important += summary.important;
    minor += summary.minor;
  }
  if (count <= 0) return undefined;
  return { count, critical, important, minor };
}

/**
 * Format a user-visible spillover line for findings hidden by a noise budget
 * cap, e.g. `…and 4 more (1 critical · 2 important · 1 minor)`. Only nonzero
 * severity buckets are listed so the line stays compact.
 * @param spillover - Spillover accounting (or the hidden issues themselves).
 * @returns The markdown spillover line, or undefined when nothing was hidden.
 */
export function formatSpilloverLine(
  spillover: SpilloverSummary | ReviewIssue[] | undefined | null,
): string | undefined {
  const summary = Array.isArray(spillover)
    ? computeSpilloverSummary(spillover)
    : (spillover ?? undefined);
  if (!summary || summary.count <= 0) return undefined;
  const parts: string[] = [];
  if (summary.critical > 0) parts.push(`${summary.critical} critical`);
  if (summary.important > 0) parts.push(`${summary.important} important`);
  if (summary.minor > 0) parts.push(`${summary.minor} minor`);
  const breakdown = parts.length > 0 ? ` (${parts.join(' · ')})` : '';
  const noun = summary.count === 1 ? 'finding' : 'findings';
  return `…and ${summary.count} more ${noun}${breakdown} — see the full run or adjust the sensitivity caps`;
}

/**
 * Normalize a noise-budget value: non-finite, zero, and negative inputs mean
 * "unlimited" (today's behavior); positive values are floored to an integer
 * with a minimum of 1.
 * @param budget - Candidate budget (e.g. `noiseBudget` / `maxVisibleFindings`).
 * @returns A positive integer budget, or undefined for unlimited.
 */
export function normalizeNoiseBudget(budget: number | undefined | null): number | undefined {
  if (budget === undefined || budget === null) return undefined;
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return undefined;
  const normalized = Math.floor(budget);
  return normalized > 0 ? normalized : undefined;
}

/**
 * Apply a severity-ordered display/post budget to a finding list: keep the
 * most severe findings up to `budget`, cut the lowest severity first, and
 * account for the cut tail as spillover. Pure function — the input order of
 * the visible findings is severity-ranked (stable for ties).
 * @param issues - Findings to cap.
 * @param budget - Maximum visible findings (undefined/null/non-positive = unlimited).
 * @returns Visible findings plus any suppressed tail and its spillover summary.
 */
export function applyNoiseBudget(
  issues: ReviewIssue[],
  budget: number | undefined | null,
): NoiseBudgetResult {
  const normalized = normalizeNoiseBudget(budget);
  if (normalized === undefined || issues.length <= normalized) {
    return { visible: [...issues], suppressed: [] };
  }
  const ordered = sortBySeverity(issues);
  return {
    visible: ordered.slice(0, normalized),
    suppressed: ordered.slice(normalized),
    spillover: computeSpilloverSummary(ordered.slice(normalized)),
  };
}
