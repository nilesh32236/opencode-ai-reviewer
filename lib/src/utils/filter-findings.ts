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
}

/** Options controlling the severity-ordered noise budget cap. */
export interface NoiseBudgetOptions {
  /** Maximum findings kept inline (severity-ordered, highest first). */
  maxInline?: number;
  /** When false, overflow is dropped without a summary spillover section. */
  spilloverToSummary?: boolean;
}

/** Result of applying the noise budget cap to review findings. */
export interface NoiseBudgetResult {
  /** Findings kept inline (severity-ordered, at most `maxInline`). */
  inline: ReviewIssue[];
  /** Lower-severity findings moved to the summary spillover. */
  overflow: ReviewIssue[];
  /** Rendered markdown spillover section ('' when disabled or nothing overflowed). */
  spillover: string;
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
 * Strip disallowed C0/DEL control characters (keeping tab and newline, which
 * are legitimate in markdown bodies). Local copy of the markdown-utils logic
 * kept here so filter-findings stays dependency-free.
 *
 * @param text - String to strip.
 * @returns String without disallowed controls.
 * @since NEXT
 */
function stripNoiseBudgetControls(text: string): string {
  let first = -1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 || code === 0x7f) && code !== 0x09 && code !== 0x0a) {
      first = i;
      break;
    }
  }
  if (first === -1) return text;
  const out: string[] = [text.slice(0, first)];
  for (let i = first; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 || code === 0x7f) && code !== 0x09 && code !== 0x0a) continue;
    out.push(text[i]);
  }
  return out.join('');
}

/**
 * Render one overflow finding as a single-line spillover bullet.
 * Self-contained (no markdown-utils import): neutralizes newlines, backticks,
 * and control characters and truncates the title to ~120 chars so one crafted
 * model message cannot inject fake sections into the summary body.
 *
 * @param issue - Overflow finding to render.
 * @returns A single-line markdown bullet (without trailing newline).
 * @since NEXT
 */
function formatNoiseBudgetOverflowLine(issue: ReviewIssue): string {
  const rawFile = String(issue.file ?? '');
  const rawLine = Number.isFinite(issue.line) ? issue.line : 0;
  const safePath = rawFile
    .replace(/[`\r\n]/g, '')
    .replace(/\|\|/g, '')
    .slice(0, 200);
  const firstLine =
    stripNoiseBudgetControls(String(issue.message ?? ''))
      .split('\n')[0]
      ?.trim() ?? '';
  const title = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return `- ${issue.severity.toUpperCase()}: \`${safePath}:${rawLine}\` — ${title}`;
}

/**
 * Render the deterministic summary spillover for noise-budget overflow.
 * Pure function: severity-ordered (critical first), header line plus one
 * bullet per overflow finding (title = first line, ~120 chars).
 *
 * @param overflow - Findings that exceeded the inline budget (any order).
 * @param maxInline - Inline cap shown in the header for context.
 * @returns Markdown spillover section, or '' when overflow is empty.
 * @since NEXT
 */
export function formatNoiseBudgetSpillover(overflow: ReviewIssue[], maxInline: number): string {
  if (!Array.isArray(overflow) || overflow.length === 0) return '';
  const ordered = [...overflow].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const lines = [
    `> ℹ️ **Additional findings (${ordered.length})** — showing top ${maxInline} inline.`,
    '',
  ];
  for (const issue of ordered) {
    lines.push(formatNoiseBudgetOverflowLine(issue));
  }
  return lines.join('\n');
}

/**
 * Apply the severity-ordered noise budget cap to review findings.
 * Keeps the highest-severity top N findings inline and spills lower-severity
 * overflow to a deterministic summary section. Fail-open: absent/zero/invalid
 * budget returns all findings inline with an empty spillover; a spillover
 * render failure still returns the inline set plus a plain count line.
 *
 * @param issues - Findings to cap (already filtered; order not required).
 * @param options - Noise budget options (`maxInline`, `spilloverToSummary`).
 * @returns Inline findings, overflow findings, and the spillover markdown.
 * @since NEXT
 */
export function applyNoiseBudget(
  issues: ReviewIssue[],
  options?: NoiseBudgetOptions,
): NoiseBudgetResult {
  const passthrough = (list: ReviewIssue[]): NoiseBudgetResult => ({
    inline: list,
    overflow: [],
    spillover: '',
  });
  try {
    if (!Array.isArray(issues)) return { inline: [], overflow: [], spillover: '' };
    const rawMax = options?.maxInline;
    if (typeof rawMax !== 'number' || !Number.isFinite(rawMax)) return passthrough(issues);
    const maxInline = Math.floor(rawMax);
    if (maxInline <= 0) return passthrough(issues);
    if (issues.length <= maxInline) return passthrough(issues);
    const ordered = sortBySeverity(issues);
    const inline = ordered.slice(0, maxInline);
    const overflow = ordered.slice(maxInline);
    if (options?.spilloverToSummary === false) {
      return { inline, overflow, spillover: '' };
    }
    try {
      return { inline, overflow, spillover: formatNoiseBudgetSpillover(overflow, maxInline) };
    } catch {
      // Fail-open: keep the inline set plus a plain count line.
      return {
        inline,
        overflow,
        spillover: `> ℹ️ **Additional findings (${overflow.length})** — showing top ${maxInline} inline.`,
      };
    }
  } catch {
    // Fail-open: never break the review when the budget block is malformed.
    return passthrough(Array.isArray(issues) ? issues : []);
  }
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
