import { minimatch } from 'minimatch';
import type {
  BlameInfo,
  CategoryOverride,
  ConfidenceThreshold,
  FindingScopeConfig,
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
  /**
   * Diff-scoping guard (additive, fail-open). Absent/false flags preserve the
   * legacy path. Guard inputs below are optional; absent maps skip that check.
   * @since NEXT
   */
  findingScope?: FindingScopeConfig;
  /**
   * Changed new-file line numbers per file (built via `parsePatchVisibleLines`).
   * Absent/empty skips the `enforceDiffScope` check fail-open.
   * @since NEXT
   */
  diffHunks?: Map<string, Set<number>> | Record<string, Set<number>>;
  /**
   * Trimmed changed-line texts per file for the `requireLineQuote` check.
   * Absent/empty skips the check fail-open.
   * @since NEXT
   */
  changedLineTexts?: Map<string, Set<string>> | Record<string, Set<string>>;
  /**
   * Blame attribution per file for the `blameDemotion` check. Absent skips
   * demotion fail-open.
   * @since NEXT
   */
  blameMap?: Map<string, Map<number, BlameInfo>> | Record<string, Map<number, BlameInfo>>;
  /**
   * Optional debug sink invoked on scope drops/demotions (the engine wires
   * `Logger.debug`). Keeps this module pure with no logger dependency.
   * @since NEXT
   */
  onScopeEvent?: (message: string, data?: unknown) => void;
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

/** One-level severity demotion floored at `minor` (no `info` tier exists). */
export function demoteSeverity(severity: Severity): Severity {
  if (severity === 'critical') return 'important';
  return 'minor';
}

/** Scope inputs for {@link validateFindingScope}. */
export interface FindingScopeContext {
  /** Changed new-file line numbers per file. */
  diffHunks?: Map<string, Set<number>> | Record<string, Set<number>>;
  /** Trimmed changed-line texts per file. */
  changedLineTexts?: Map<string, Set<string>> | Record<string, Set<string>>;
  /** Blame attribution per file. */
  blameMap?: Map<string, Map<number, BlameInfo>> | Record<string, Map<number, BlameInfo>>;
}

/** Outcome of a single-finding scope check. */
export interface FindingScopeVerdict {
  /** False when the finding must be dropped. */
  keep: boolean;
  /** Present when blame demotion applied (severity lowered, never raised). */
  demoted?: ReviewIssue;
  /** Machine-readable reason (`outside-diff`, `quote-mismatch`, `blame-demoted`). */
  reason?: string;
}

function lookupLineSet(
  source: Map<string, Set<number>> | Record<string, Set<number>> | undefined,
  file: string,
): Set<number> | undefined {
  if (!source) return undefined;
  if (source instanceof Map) return source.get(file);
  const set = (source as Record<string, Set<number>>)[file];
  return set instanceof Set ? set : undefined;
}

function lookupTextSet(
  source: Map<string, Set<string>> | Record<string, Set<string>> | undefined,
  file: string,
): Set<string> | undefined {
  if (!source) return undefined;
  if (source instanceof Map) return source.get(file);
  const set = (source as Record<string, Set<string>>)[file];
  return set instanceof Set ? set : undefined;
}

function lookupBlame(
  source: Map<string, Map<number, BlameInfo>> | Record<string, Map<number, BlameInfo>> | undefined,
  file: string,
  line: number,
): BlameInfo | undefined {
  if (!source) return undefined;
  const perFile = source instanceof Map ? source.get(file) : source[file];
  if (!perFile || !(perFile instanceof Map)) return undefined;
  return perFile.get(line);
}

const CODE_FENCE_REGEX = /```(?:\w+)?\s*\n?([\s\S]*?)```/;

/**
 * Extract the quoted code under test for `requireLineQuote`: `suggestionCode`
 * first, then `suggestion`, then the first fenced block in `message`.
 *
 * @param finding - Finding to extract the quote from.
 * @returns The raw quote, or undefined when the finding carries no quotable code.
 */
export function extractFindingQuote(finding: ReviewIssue): string | undefined {
  const direct = finding.suggestionCode ?? finding.suggestion;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;
  if (typeof finding.message === 'string') {
    const match = CODE_FENCE_REGEX.exec(finding.message);
    if (match?.[1]?.trim()) return match[1];
  }
  return undefined;
}

/**
 * Validate a single finding against the diff-scope guard.
 *
 * Pure local string/number comparison — no model calls, no network. Every
 * branch is fail-open: absent `diffHunks`/`changedLineTexts`/`blameMap`
 * entries skip that check, and normalization errors keep the finding.
 *
 * Order: (a) `enforceDiffScope` drops findings outside changed hunks;
 * (b) `requireLineQuote` drops findings whose quote matches no changed line
 * after trim; (c) `blameDemotion` demotes (one level, floored at `minor`)
 * findings on lines blame marks outside this PR instead of dropping them.
 *
 * @param finding - Finding under test.
 * @param scope - Scope flags (absent/empty = legacy path, always keep).
 * @param context - Diff hunks, changed-line texts, and blame maps.
 * @returns Verdict with `keep: false` for drops or a `demoted` copy for demotions.
 * @since NEXT
 */
export function validateFindingScope(
  finding: ReviewIssue,
  scope: FindingScopeConfig | undefined,
  context: FindingScopeContext = {},
): FindingScopeVerdict {
  try {
    if (!scope || (!scope.enforceDiffScope && !scope.requireLineQuote && !scope.blameDemotion)) {
      return { keep: true };
    }

    if (scope.enforceDiffScope && context.diffHunks) {
      const lines = lookupLineSet(context.diffHunks, finding.file);
      // Only enforce when hunk data exists for this file; absent file data
      // means the diff was unavailable (fail-open), not "outside the diff".
      if (lines && lines.size > 0 && !lines.has(finding.line)) {
        return { keep: false, reason: 'outside-diff' };
      }
    }

    if (scope.requireLineQuote && context.changedLineTexts) {
      const texts = lookupTextSet(context.changedLineTexts, finding.file);
      if (texts && texts.size > 0) {
        const quote = extractFindingQuote(finding);
        // Findings without quotable code are kept fail-open; only a present
        // but non-matching quote is dropped.
        if (quote !== undefined) {
          const quoteLines = quote
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          const matched = quoteLines.some((q) => texts.has(q));
          if (!matched) return { keep: false, reason: 'quote-mismatch' };
        }
      }
    }

    if (scope.blameDemotion && context.blameMap) {
      const blame = lookupBlame(context.blameMap, finding.file, finding.line);
      if (blame && blame.isInPRDiff === false && finding.severity !== 'minor') {
        return {
          keep: true,
          demoted: { ...finding, severity: demoteSeverity(finding.severity) },
          reason: 'blame-demoted',
        };
      }
    }

    return { keep: true };
  } catch {
    // Quote normalization or map lookups must never drop signal on error.
    return { keep: true };
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

    // Diff-scoping guard: drop outside-diff / quote-mismatch findings, demote
    // unchanged-blame lines. Fail-open when hunk/text/blame data is absent.
    let candidate: ReviewIssue = { ...issue, category };
    if (options.findingScope) {
      const verdict = validateFindingScope(candidate, options.findingScope, {
        diffHunks: options.diffHunks,
        changedLineTexts: options.changedLineTexts,
        blameMap: options.blameMap,
      });
      if (!verdict.keep) {
        options.onScopeEvent?.(
          `finding-scope: dropped ${candidate.file}:${candidate.line} (${verdict.reason})`,
          { file: candidate.file, line: candidate.line, reason: verdict.reason },
        );
        continue;
      }
      if (verdict.demoted) {
        options.onScopeEvent?.(
          `finding-scope: demoted ${candidate.file}:${candidate.line} (${verdict.reason})`,
          {
            file: candidate.file,
            line: candidate.line,
            from: candidate.severity,
            to: verdict.demoted.severity,
          },
        );
        candidate = { ...verdict.demoted, category };
      }
    }

    remaining.push(candidate);
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
