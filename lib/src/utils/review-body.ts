import type {
  ReviewIssue,
  ReviewResult,
  Severity,
  TokenUsage,
  VerdictMode,
} from '../types/index.js';
import {
  type SpilloverSummary,
  applyNoiseBudget,
  computeSpilloverSummary,
  formatSpilloverLine,
  mergeSpilloverSummaries,
} from './filter-findings.js';
import { buildFixPayload, formatFixPayloadMarkdown } from './fix-payload.js';
import {
  type FunctionScore,
  type FunctionScoreInput,
  buildFunctionScoreTable,
} from './function-scores.js';
import { Logger } from './logger.js';
import { escapeInlineCode, sanitizeMarkdown } from './markdown.js';

/** Optional rendering options for {@link buildReviewBody}. */
export interface ReviewBodyOptions {
  /** When true, append the deterministic per-function score table. */
  showFunctionScores?: boolean;
  /** Changed-function inputs used to compute the score table. */
  functionScores?: Array<FunctionScoreInput | FunctionScore>;
  /**
   * Opt-in to posting mappable findings as a single reviews-array request
   * (`POST /pulls/{n}/reviews` with `comments[]`) with a summary-only retry
   * on 422/403/429. Default false (legacy behavior unchanged).
   * @since NEXT
   */
  enableReviewsArrayInline?: boolean;
  /**
   * Opt-in review gating mode mapped to the Pulls `createReview` event
   * (`comment` default, `approve`, `request-changes`). Transport only — the
   * body render is unchanged; `GitHubHelper.postReview()` resolves the event.
   * @since NEXT
   */
  verdictMode?: VerdictMode;
  /**
   * Skip inline findings whose fingerprint already appears in previously
   * posted bot threads. Default true (absent = enabled). Set false to post
   * as today. Ignored when `updateInPlace` is true (matched threads are
   * updated instead of skipped).
   * @since NEXT
   */
  dedupFingerprints?: boolean;
  /**
   * Previously posted inline-finding fingerprints (e.g. collected from bot
   * review threads via `collectFingerprintsFromBodies`). When absent/empty
   * the dedup gate is a no-op (fail-open, posts as today).
   * @since NEXT
   */
  previousFingerprints?: Set<string> | string[];
  /**
   * Coarse legacy keys for threads posted before the fingerprint marker
   * existed (see `legacyInlineKey`). Best-effort fallback only.
   * @since NEXT
   */
  previousInlineKeys?: Set<string> | string[];
  /**
   * Opt-in to appending a one-click Fix-with-AI payload (```suggestion block
   * plus a Fix-with-AI prompt) to each rendered finding. Default false
   * (legacy output unchanged). Fail-open: payload errors render plain finding.
   * @since NEXT
   */
  emitFixPayload?: boolean;
  /**
<  /**
   * Pre-split overflow findings for the collapsed summary section. When
   * non-empty, their severity counts merge into the spillover line and
   * `result.issues` renders inline as-is. Prefer `maxVisibleFindings` /
   * `noiseBudget` — this escape hatch exists for callers that split upstream.
   * @since NEXT
   */
  spilledIssues?: ReviewIssue[];
  /**
   * Opt-in to persistent inline update-in-place: findings whose fingerprint
   * already matches a previously posted bot thread (see
   * `previousFingerprintCommentIds`) are edited via
   * `PATCH /pulls/comments/{id}` instead of being skipped or re-posted, so
   * re-pushes never create duplicate threads. Default false (legacy behavior
   * unchanged). Fail-open: match/update failures fall back to posting a new
   * thread as today.
   * @since NEXT
   */
  updateInPlace?: boolean;
  /**
   * Fingerprint-to-commentId map for `updateInPlace` matching (e.g. built via
   * `mapFingerprintsToCommentIds` from previously posted bot threads). When
   * absent/empty with `updateInPlace` enabled, all findings post as today.
   * @since NEXT
   */
  previousFingerprintCommentIds?: Map<string, number> | Record<string, number>;
  /**
   * Opt-in to emitting one Checks run carrying deterministic finding counts
   * after the review posts (a single extra `createCheckRun` call only when
   * enabled). Default false (no Checks call). Fail-open: Checks API errors
   * warn and never fail the review.
   * @since NEXT
   */
  emitChecksSummary?: boolean;
  /** Attribution footer for auto-loaded review conventions (e.g. AGENTS.md @
   * head SHA). Appended after the issues section when non-empty. Falls back to
   * `result.attributionFooter` when omitted. */
  attributionFooter?: string;
  /**
   * Display noise budget: maximum findings rendered in the `### Issues`
   * section (highest severity first). The hidden tail is reported as a
   * user-visible "+N more" spillover line instead of being silently dropped.
   * Undefined = unlimited (legacy behavior).
   * @since NEXT
   */
  maxVisibleFindings?: number;
  /**
   * Alias for `maxVisibleFindings` mirroring the
   * `review.sensitivity.noiseBudget` config key. `maxVisibleFindings` wins
   * when both are set.
   * @since NEXT
   */
  noiseBudget?: number;
}

/**
 * Compute a 0-5 merge-readiness score from a review result, modeled on
 * Greptile's confidence score. Weighted by severity counts (critical weighs
 * more than important/minor), the verdict, and whether the review was partial.
 *
 *   5 = production-ready     4 = minor polish  3 = address feedback first
 *   2 = significant bugs     0-1 = critical problems / unreviewed
 *
 * @param result - The review result to score.
 * @returns An integer 0-5.
 */
export function computeMergeScore(result: ReviewResult): number {
  if (!result || result.verdict.ready === false || result.skipped) return 0;
  const stats = result.stats ?? {
    total: 0,
    critical: 0,
    important: 0,
    minor: 0,
  };
  const critical = stats.critical ?? 0;
  const important = stats.important ?? 0;
  const minor = stats.minor ?? 0;

  // A partial review (failed batches/agents) was never fully verified, so it
  // can never be "merge-ready" — score it low regardless of what was parsed.
  if ((result.failedBatches ?? 0) > 0 || (result.failedAgents ?? 0) > 0) {
    return 1;
  }

  if (critical > 0) return 1;
  if (important > 0) {
    // Multiple important issues keep the score low; one important issue is a
    // "address before merge" signal.
    return important >= 2 ? 2 : 3;
  }
  if (minor > 0) return 4;
  return 5;
}

/**
 * Render a merge-readiness score as a short markdown line with an explicit
 * text label so the readiness band does not rely on color or emoji alone.
 * Screen readers and color-blind readers get the band meaning from the label.
 * The leading emoji is decorative-only; the adjacent text label is the
 * normative cue (raw GitHub markdown emoji cannot carry aria-hidden).
 * @param score - The 0-5 score.
 * @returns A markdown string like "**Merge-readiness:** 🟢 ready 5/5".
 */
export function formatMergeScore(score: number): string {
  const badge = score >= 5 ? '🟢' : score >= 4 ? '🟡' : score >= 3 ? '🟠' : '🔴';
  const label =
    score >= 5
      ? 'ready'
      : score === 4
        ? 'minor polish'
        : score === 3
          ? 'address feedback'
          : 'needs work';
  return `${badge} ${label} ${score}/5`;
}

/**
 * Get an emoji badge aligned with a finding's severity.
 * The badge is decorative-only; every call site pairs it with an explicit
 * `CRITICAL`/`IMPORTANT`/`MINOR` text label as the normative severity cue.
 * @param severity - Severity of the issue.
 * @returns Emoji string representing the severity.
 */
export function getSeverityBadge(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return '🔴';
    case 'important':
      return '🟠';
    case 'minor':
      return '🔵';
  }
}

/**
 * Format a duration in milliseconds as a human-readable seconds string.
 * @param durationMs - Duration in milliseconds.
 * @returns A seconds string (e.g. "12.3s").
 */
function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Build a markdown token usage summary section from accumulated telemetry.
 * Renders totals plus duration, and includes the prompt/completion breakdown
 * and estimated cost when available. Returns an empty string when nothing was
 * measured so callers never render a misleading zero-token table.
 * @param usage - Accumulated token usage data.
 * @returns Markdown string for the token usage section, or '' when empty.
 */
export function buildTokenUsageSection(usage: TokenUsage): string {
  if (usage.totalTokens === 0 && usage.estimatedCost === undefined) {
    return '';
  }
  const lines: string[] = [
    '---',
    '',
    '### Token Usage',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Tokens | ${usage.totalTokens.toLocaleString()} |`,
  ];
  if (usage.promptTokens !== undefined) {
    lines.push(`| Prompt Tokens | ${usage.promptTokens.toLocaleString()} |`);
  }
  if (usage.completionTokens !== undefined) {
    lines.push(`| Completion Tokens | ${usage.completionTokens.toLocaleString()} |`);
  }
  lines.push(`| Duration | ${formatDuration(usage.durationMs)} |`);
  if (usage.estimatedCost !== undefined) {
    lines.push(`| Estimated Cost | $${usage.estimatedCost.toFixed(4)} |`);
  }
  return lines.join('\n');
}

/**
 * Format a confidence level as an explicit text label suffix.
 * @param confidence - Confidence level of the finding.
 * @returns A markdown suffix, or an empty string for high/undefined confidence.
 */
export function formatConfidenceLabel(confidence?: 'high' | 'medium' | 'low'): string {
  switch (confidence) {
    case 'low':
      return ' **[low confidence]**';
    case 'medium':
      return ' **[medium confidence]**';
    default:
      return '';
  }
}

/**
 * Format a single issue as a markdown bullet, sharing one canonical render
 * across review bodies and inline comments.
 * @param issue - Issue to render.
 * @returns A markdown bullet string.
 */
export function formatIssueBullet(issue: ReviewIssue): string {
  // Insert a zero-width space after each '/' so long file paths inside the
  // inline code span can break at directory boundaries on narrow viewports
  // instead of overflowing horizontally.
  // The path is inline-code-escaped first: it is model-generated and could
  // otherwise break out of the code span with backticks or newlines.
  const codePath = escapeInlineCode(`${issue.file}:${issue.line}`).replace(/\//g, '/\u200b');
  return `- ${getSeverityBadge(issue.severity)} **${issue.severity.toUpperCase()}:** \`${codePath}\` — ${sanitizeMarkdown(issue.message)}${formatConfidenceLabel(issue.confidence)}`;
}

/**
 * @deprecated Use {@link ReviewBodyOptions} instead — retained as an alias for
 * backward compatibility with callers written against the earlier name.
 */
export type BuildReviewBodyOptions = ReviewBodyOptions;

/**
 * Build the attribution footer for review conventions auto-loaded from the PR
 * head SHA (AGENTS.md / copilot-instructions.md). Pure function, safe to unit
 * test. Returns undefined when nothing was loaded so callers render no footer.
 * @param headSha - Full head commit SHA the conventions were read at.
 * @param sources - Convention filenames that were loaded (e.g. ['AGENTS.md']).
 * @returns A one-line markdown footer, or undefined when sources is empty.
 */
export function buildAgentsMdAttributionFooter(
  headSha: string,
  sources: string[],
): string | undefined {
  if (!sources || sources.length === 0) return undefined;
  const shortSha = sanitizeMarkdown(String(headSha || '').slice(0, 7) || 'unknown');
  const names = sources.map((s) => `\`${escapeInlineCode(sanitizeMarkdown(s))}\``).join(', ');
  return `*Review conventions auto-loaded from ${names} @ \`${shortSha}\`*`;
}

/**
 * Build the collapsed spillover summary for findings relocated by the noise
 * budget cap. Pure function, safe to unit test. Returns an empty string when
 * there is nothing to spill so callers render no extra section.
 * @param spilled - Overflow findings (already severity-ordered).
 * @param budget - The active noise budget (rendered for transparency).
 * @returns Markdown `<details>` block, or '' when `spilled` is empty.
 * @since NEXT
 */
export function buildNoiseBudgetSpillover(spilled: ReviewIssue[], budget: number): string {
  if (!spilled || spilled.length === 0) return '';
  const critical = spilled.filter((i) => i.severity === 'critical').length;
  const important = spilled.filter((i) => i.severity === 'important').length;
  const minor = spilled.filter((i) => i.severity === 'minor').length;
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (important > 0) parts.push(`${important} important`);
  if (minor > 0) parts.push(`${minor} minor`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const lines: string[] = [
    `<details><summary>Show ${spilled.length} additional finding${spilled.length === 1 ? '' : 's'}${breakdown} — noise budget ${budget}</summary>`,
    '',
  ];
  for (const issue of spilled) {
    lines.push(formatIssueBullet(issue));
  }
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

/**
 * Build a markdown review body from a ReviewResult.
 * @param result - Review result to render.
 * @param options - Optional rendering options (attribution footer and/or
 * deterministic function scores).
 * @returns Formatted markdown string.
 */
export function buildReviewBody(result: ReviewResult, options?: ReviewBodyOptions): string {
  const lines: string[] = [];

  if (result.failedBatches !== undefined && result.failedBatches > 0) {
    lines.push(
      `> ⚠️ **Partial review** — ${result.failedBatches} file batch(es) failed; findings may be missing.`,
    );
    lines.push('');
  }

  if (result.failedAgents !== undefined && result.failedAgents > 0) {
    lines.push(
      `> ⚠️ **Partial review** — ${result.failedAgents} agent(s) failed; findings may be missing.`,
    );
    lines.push('');
  }

  if (result.executiveSummary) {
    const es = result.executiveSummary;
    const riskEmoji = es.riskLevel === 'high' ? '🔴' : es.riskLevel === 'medium' ? '🟡' : '🟢';
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(`**Purpose:** ${sanitizeMarkdown(es.purpose)}`);
    lines.push('');
    lines.push(
      `**Risk:** ${riskEmoji} ${es.riskLevel.toUpperCase()} — ${sanitizeMarkdown(es.riskRationale)}`,
    );
    if (es.breakingChanges.length > 0) {
      lines.push('');
      lines.push('**Breaking Changes:**');
      for (const bc of es.breakingChanges) {
        lines.push(`- ⚠️ ${sanitizeMarkdown(bc)}`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push(
    '## MR Review Summary',
    '',
    sanitizeMarkdown(result.summary),
    '',
    // A partial review (failed batches/agents) was never fully verified, so it
    // must never be displayed as ready to merge even when the verdict says so.
    // This keeps the readiness line consistent with the 1/5 merge score below.
    `**Ready to merge?** ${
      (result.failedBatches ?? 0) > 0 || (result.failedAgents ?? 0) > 0 || !result.verdict.ready
        ? 'No'
        : 'Yes'
    }`,
    '',
    `**Merge-readiness:** ${formatMergeScore(computeMergeScore(result))}`,
    '',
    `**Reasoning:** ${sanitizeMarkdown(result.verdict.reasoning)}`,
    '',
  );

  if (result.strengths.length > 0) {
    lines.push('### Strengths');
    lines.push('');
    for (const s of result.strengths) {
      // Same zero-width-space treatment as formatIssueBullet so long paths
      // break at directory boundaries on narrow viewports.
      const codePath = escapeInlineCode(`${s.file}:${s.line}`).replace(/\//g, '/\u200b');
      lines.push(`- **\`${codePath}\`** — ${sanitizeMarkdown(s.message ?? '')}`);
    }
    lines.push('');
  }

  if (result.issues.length > 0) {
    lines.push('### Issues');
    lines.push('');
    // Severity-ordered noise budget: cap the rendered findings (most severe
    // first) and account for the hidden tail as a visible spillover line.
    // Incoming `result.spillover` (e.g. from sensitivity-cap filtering or
    // capped inline comments) is merged in so nothing is silently dropped.
    // An explicit `options.spilledIssues` pre-split (legacy escape hatch)
    // merges into the same accounting.
    const budget = options?.maxVisibleFindings ?? options?.noiseBudget;
    const { visible: visibleIssues, spillover: budgetSpillover } = applyNoiseBudget(
      result.issues,
      budget,
    );
    let explicitSpillover: SpilloverSummary | undefined;
    try {
      const explicit = options?.spilledIssues;
      if (explicit && explicit.length > 0) explicitSpillover = computeSpilloverSummary(explicit);
    } catch {
      explicitSpillover = undefined;
    }
    for (const i of visibleIssues) {
      lines.push(formatIssueBullet(i));
      if (i.suggestion) {
        lines.push(`  > 💡 **How to fix:** ${sanitizeMarkdown(i.suggestion)}`);
      }
      if (i.suggestionCode) {
        // Unique summary landmark per finding so screen-reader users can
        // distinguish N identical disclosures; anchor reuses the already
        // inline-code-escaped file:line form.
        const anchor = escapeInlineCode(`${i.file}:${i.line}`);
        lines.push(`<details><summary>Show suggested fix for <code>${anchor}</code></summary>`);
        lines.push('');
        lines.push('```suggestion');
        lines.push(i.suggestionCode.trim());
        lines.push('```');
        lines.push('</details>');
      }
      if (options?.emitFixPayload === true) {
        try {
          const payload = buildFixPayload(i);
          // Summary body above already renders the suggestion fence; keep only
          // the Fix-with-AI prompt to avoid a duplicate suggestion block.
          if (i.suggestionCode?.trim()) payload.suggestedChange = undefined;
          const rendered = formatFixPayloadMarkdown(payload, `${i.file}:${i.line}`);
          if (rendered) {
            lines.push('');
            lines.push(rendered);
          }
        } catch {
          // Fail-open: keep the plain finding when payload rendering fails.
        }
      }
    }
    const spillover: SpilloverSummary | undefined = mergeSpilloverSummaries(
      result.spillover,
      budgetSpillover,
      explicitSpillover,
    );
    const spilloverLine = formatSpilloverLine(spillover);
    if (spilloverLine) {
      lines.push(`- _${sanitizeMarkdown(spilloverLine)}_`);
    }
  } else if (result.spillover !== undefined && result.spillover.count > 0) {
    // Every finding was capped away (e.g. the sensitivity filter kept none):
    // still surface the spillover accounting instead of rendering no section.
    const spilloverLine = formatSpilloverLine(result.spillover);
    if (spilloverLine) {
      lines.push('### Issues');
      lines.push('');
      lines.push(`- _${sanitizeMarkdown(spilloverLine)}_`);
    }
  }

  // Token usage / cost is deliberately NOT rendered here: it is surfaced once
  // via the dedicated post-step comment (action/src/post.ts), which is gated on
  // the saved state and is verbosity-aware. Rendering it here too would show
  // the same totals twice on the same PR.
  const footer = options?.attributionFooter ?? result.attributionFooter;
  if (footer?.trim()) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(sanitizeMarkdown(footer));
  }

  if (options?.showFunctionScores === true) {
    try {
      const inputs: Array<FunctionScoreInput | FunctionScore> = options.functionScores ?? [];
      const table = inputs.length === 0 ? '' : buildFunctionScoreTable(inputs);
      if (table) {
        lines.push('');
        lines.push(table);
      }
    } catch (error) {
      // Fail-open: symbol extraction or scoring must never break the review.
      new Logger('review-body').info(
        `Omitting function score table: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return lines.join('\n');
}
