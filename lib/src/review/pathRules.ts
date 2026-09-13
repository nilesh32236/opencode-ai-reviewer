import { minimatch } from 'minimatch';
import { isValidPathGlob } from '../config.js';
import type { PathRule } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('path-rules');

/**
 * Suggested reviewers for a rule, reading the canonical camelCase key with a
 * fallback to the legacy snake_case alias (for rules that bypassed
 * `sanitizePathRules` normalization).
 */
function reviewersOf(rule: PathRule): string[] {
  return rule.suggestReviewers ?? rule.suggest_reviewers ?? [];
}

/**
 * Auto-labels for a rule, reading the canonical camelCase key with a fallback
 * to the legacy snake_case alias (for rules that bypassed `sanitizePathRules`
 * normalization).
 */
function labelsOf(rule: PathRule): string[] {
  return rule.addLabels ?? rule.add_labels ?? [];
}

/** Aggregated outcome of matching path rules against a changed-file list.
 * @since NEXT
 */
export interface PathRuleOutcomes {
  /** Rules with at least one matching file. */
  matchedRules: PathRule[];
  /** Files excluded from review by a `skip: true` rule. */
  skippedFiles: string[];
  /** Files remaining after skip filtering. */
  keptFiles: string[];
  /** Deduplicated suggested reviewers (summary-only, no API call). */
  suggestedReviewers: string[];
  /** Deduplicated labels to apply best-effort via the platform adapter. */
  labelsToApply: string[];
}

/**
 * Return the subset of rules matching a single file. Fail-open: invalid or
 * absent inputs yield `[]` and never throw.
 * @param file - Repo-relative file path.
 * @param rules - Optional path rules from `review.pathRules`.
 * @returns Matched rules in config order.
 * @since NEXT
 */
export function matchPathRules(file: string, rules: PathRule[] | undefined): PathRule[] {
  if (!file || !Array.isArray(rules) || rules.length === 0) return [];
  const matched: PathRule[] = [];
  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.paths) || rule.paths.length === 0) continue;
    let hit = false;
    for (const glob of rule.paths) {
      if (typeof glob !== 'string' || !isValidPathGlob(glob)) continue;
      try {
        if (minimatch(file, glob, { dot: true })) {
          hit = true;
          break;
        }
      } catch {
        logger.warn(`Ignoring pathRules glob: invalid glob "${glob}"`);
      }
    }
    if (hit) matched.push(rule);
  }
  return matched;
}

/**
 * Match path rules against a changed-file list and aggregate skip, reviewer,
 * and label outcomes. Fail-open: invalid inputs yield empty outcomes.
 * @param changedFiles - Repo-relative changed file paths.
 * @param rules - Optional path rules from `review.pathRules`.
 * @returns Aggregated {@link PathRuleOutcomes}.
 * @since NEXT
 */
export function collectPathRuleOutcomes(
  changedFiles: string[],
  rules: PathRule[] | undefined,
): PathRuleOutcomes {
  const empty: PathRuleOutcomes = {
    matchedRules: [],
    skippedFiles: [],
    keptFiles: [...(Array.isArray(changedFiles) ? changedFiles : [])],
    suggestedReviewers: [],
    labelsToApply: [],
  };
  if (!Array.isArray(changedFiles) || !Array.isArray(rules) || rules.length === 0) return empty;
  const matchedSet = new Set<PathRule>();
  const skipped = new Set<string>();
  const reviewers: string[] = [];
  const reviewerSet = new Set<string>();
  const labels: string[] = [];
  const labelSet = new Set<string>();
  for (const file of changedFiles) {
    if (typeof file !== 'string' || file.length === 0) continue;
    const matched = matchPathRules(file, rules);
    for (const rule of matched) {
      matchedSet.add(rule);
      if (rule.skip === true) skipped.add(file);
      for (const r of reviewersOf(rule)) {
        if (!reviewerSet.has(r)) {
          reviewerSet.add(r);
          reviewers.push(r);
        }
      }
      for (const label of labelsOf(rule)) {
        if (!labelSet.has(label)) {
          labelSet.add(label);
          labels.push(label);
        }
      }
    }
  }
  return {
    matchedRules: [...matchedSet],
    skippedFiles: [...skipped],
    keptFiles: changedFiles.filter((f) => typeof f === 'string' && !skipped.has(f)),
    suggestedReviewers: reviewers,
    labelsToApply: labels,
  };
}

/**
 * Render matched path-rule routing as a markdown section appended to the
 * review summary. Returns an empty string when nothing matched.
 * @param outcomes - Output of {@link collectPathRuleOutcomes}.
 * @returns Markdown section or an empty string.
 * @since NEXT
 */
export function buildPathRulesSection(outcomes: PathRuleOutcomes): string {
  const { suggestedReviewers, labelsToApply, skippedFiles } = outcomes;
  if (suggestedReviewers.length === 0 && labelsToApply.length === 0 && skippedFiles.length === 0) {
    return '';
  }
  const sanitize = (v: string): string =>
    v
      .replace(/[`\r\n\u2028\u2029]+/g, ' ')
      .trim()
      .slice(0, 200);
  const lines: string[] = ['### Path-based Review Routing', ''];
  if (suggestedReviewers.length > 0) {
    lines.push(
      `Suggested reviewers: ${suggestedReviewers.map((r) => `@${sanitize(r)}`).join(', ')}`,
    );
    lines.push('');
  }
  if (labelsToApply.length > 0) {
    lines.push(`Auto labels: ${labelsToApply.map((l) => `\`${sanitize(l)}\``).join(', ')}`);
    lines.push('');
  }
  if (skippedFiles.length > 0) {
    const shown = skippedFiles.slice(0, 20).map((f) => `\`${sanitize(f)}\``);
    const extra =
      skippedFiles.length > shown.length ? ` (+${skippedFiles.length - shown.length} more)` : '';
    lines.push(
      `Skipped ${skippedFiles.length} file(s) by path rule (not reviewed): ${shown.join(', ')}${extra}`,
    );
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
