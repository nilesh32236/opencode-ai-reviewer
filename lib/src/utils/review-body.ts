import type { CodebaseIndexData } from '../codebase-index/types.js';
import type {
  ChangedFile,
  ReviewIssue,
  ReviewResult,
  ReviewTrust,
  Severity,
  TokenUsage,
  VerdictMode,
} from '../types/index.js';
import {
  type SpilloverSummary,
  applyNoiseBudget,
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
import {
  estimateReviewMinutes,
  formatEffortMinutesLine,
  formatSelfReviewChecklist,
} from './review-minutes.js';

/** Optional rendering options for {@link buildReviewBody}. */
export interface ReviewBodyOptions {
  /**
   * Invoked when the assembled body had to be truncated to fit GitHub's
   * review-body limit.
   *
   * Truncation is a DEGRADATION and must never be silent: the caller uses this
   * to report it in the job summary, so a capped review cannot pass for a
   * complete one.
   * @since NEXT
   */
  onTruncate?: (info: TruncatedReviewBody) => void;
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
   * Auto-resolve bot inline threads whose fingerprinted finding no longer
   * reproduces in the fresh review of the new head SHA. Default true (absent
   * = enabled). Set false to leave addressed threads open. Fail-open: resolve
   * API errors leave the thread open and never fail the review. Requires
   * `previousBotThreads`; without history this is a no-op.
   * @since NEXT
   */
  autoResolveAddressed?: boolean;
  /**
   * Previously posted bot threads for `autoResolveAddressed` matching (e.g.
   * from `getBotReviewThreads`). Threads without an embedded fingerprint
   * marker or already resolved are ignored (fail-open, stay open).
   * @since NEXT
   */
  previousBotThreads?: Array<{ threadId: string; isResolved: boolean; body: string }>;
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
   * Opt-in to appending a deterministic blast-radius section listing callers
   * and importers of changed files from the cached codebase index graph.
   * Default false (legacy output unchanged). Fail-open: omitted when no
   * index data or no dependents are found.
   * @since NEXT
   */
  showBlastRadius?: boolean;
  /**
   * Changed file paths used to look up dependents in `codebaseIndex`.
   * @since NEXT
   */
  changedFiles?: string[];
  /**
   * Already-built codebase index data (reused, never rebuilt here). When
   * absent/null the blast-radius section is omitted (fail-open).
   * @since NEXT
   */
  codebaseIndex?: CodebaseIndexData | null;
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
  /**
   * Show the deterministic review-effort minutes estimate line
   * (`**Review effort:** ~N min`). Default true (absent = enabled). Set
   * false to hide. Fail-open: estimate failures omit the line and render
   * the rest of the comment.
   * @since NEXT
   */
  showEffortEstimate?: boolean;
  /**
   * Explicit effort-minutes override. When set to a positive finite number
   * it is rendered as-is; otherwise it is estimated from
   * `changedFilesForEffort` churn plus finding counts.
   * @since NEXT
   */
  effortMinutes?: number;
  /**
   * Changed files with churn stats used to estimate review effort.
   * @since NEXT
   */
  changedFilesForEffort?: ChangedFile[];
  /**
   * Show the static author self-review checklist line
   * (`- [ ] Author self-review: ...`). Default true (absent = enabled).
   * Static markdown with no state dependency. Set false to hide.
   * @since NEXT
   */
  showSelfReviewChecklist?: boolean;
}

/** Caps for the deterministic blast-radius section. */
export const MAX_BLAST_RADIUS_DEPENDENTS = 10;
export const MAX_BLAST_RADIUS_CHARS = 2048;

/** Options for {@link buildBlastRadiusSection}. */
export interface BlastRadiusSectionOptions {
  /** Max dependent files to list (default 10). */
  maxDependents?: number;
  /** Max markdown chars for the section (default 2048). */
  maxChars?: number;
}

/**
 * Normalize a file path to forward-slash form for graph comparison.
 * @param file - Raw file path (relative or absolute).
 * @returns Normalized path with backslashes converted to forward slashes.
 */
function normalizeBlastRadiusPath(file: string): string {
  return String(file ?? '').replace(/\\/g, '/');
}

/**
 * Build a deterministic blast-radius markdown section listing external
 * dependents (importers and callers) of the changed files using the cached
 * codebase index graph. Pure lookup — no model call, no index rebuild.
 * @param changedFiles - Changed file paths (relative or absolute suffixes).
 * @param indexData - Already-built codebase index data, or null/undefined.
 * @param opts - Optional caps for dependents and chars.
 * @returns Markdown section, or '' when there is nothing to render.
 */
export function buildBlastRadiusSection(
  changedFiles: string[] | undefined,
  indexData: CodebaseIndexData | null | undefined,
  opts?: BlastRadiusSectionOptions,
): string {
  if (!changedFiles || changedFiles.length === 0 || !indexData) return '';
  const maxDependents = opts?.maxDependents ?? MAX_BLAST_RADIUS_DEPENDENTS;
  const maxChars = opts?.maxChars ?? MAX_BLAST_RADIUS_CHARS;
  if (maxDependents <= 0 || maxChars <= 0) return '';

  const changedSet = new Set(changedFiles.map(normalizeBlastRadiusPath));
  if (changedSet.size === 0) return '';

  // dependent file -> set of reasons ('imported by' / 'called by')
  const dependents = new Map<string, Set<string>>();
  const track = (file: string, reason: string): void => {
    const normalized = normalizeBlastRadiusPath(file);
    if (!normalized || changedSet.has(normalized)) return;
    let reasons = dependents.get(normalized);
    if (!reasons) {
      reasons = new Set<string>();
      dependents.set(normalized, reasons);
    }
    reasons.add(reason);
  };

  try {
    for (const edge of indexData.imports ?? []) {
      if (!edge.targetFile) continue;
      if (changedSet.has(normalizeBlastRadiusPath(edge.targetFile))) {
        track(edge.sourceFile, 'imports changed file');
      }
    }
    for (const edge of indexData.callGraph ?? []) {
      // Skip intra-file edges: self-contained calls do not expand blast radius.
      if (edge.callerFile === edge.calleeFile) continue;
      if (changedSet.has(normalizeBlastRadiusPath(edge.calleeFile))) {
        track(edge.callerFile, 'calls changed code');
      }
    }
  } catch {
    // Fail-open: graph lookup must never break the review render.
    return '';
  }

  if (dependents.size === 0) return '';

  const sorted = [...dependents.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const total = sorted.length;
  const shown = sorted.slice(0, maxDependents);
  const lines: string[] = [
    '### 💥 Blast Radius',
    '',
    'Files that may be affected by these changes:',
    '',
  ];
  for (const [file, reasons] of shown) {
    const codePath = escapeInlineCode(file).replace(/\//g, '/\u200b');
    lines.push(`- \`${codePath}\` — ${sanitizeMarkdown([...reasons].sort().join(', '))}`);
  }
  if (total > shown.length) {
    lines.push(`- ... and ${total - shown.length} more (list truncated)`);
  }
  let section = lines.join('\n');
  if (section.length > maxChars) {
    section = `${section.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return section;
}

/**
 * Build the trailing options bag for `postReview`/`buildReviewBody` from the
 * review config flag and the cached codebase index. Returns `undefined` when
 * the flag is off or no index data is available so callers can spread the
 * result straight through.
 * @param showBlastRadius - Config flag (`review.showBlastRadius`).
 * @param changedFiles - Changed file paths from the PR context.
 * @param codebaseIndex - Already-built index data (reused, never rebuilt).
 * @returns Options bag, or `undefined` when disabled/unavailable.
 */
export function buildBlastRadiusOptions(
  showBlastRadius: boolean | undefined,
  changedFiles: string[] | undefined,
  codebaseIndex: CodebaseIndexData | null | undefined,
): { showBlastRadius: true; changedFiles: string[]; codebaseIndex: CodebaseIndexData } | undefined {
  if (showBlastRadius !== true) return undefined;
  if (!changedFiles || changedFiles.length === 0 || !codebaseIndex) return undefined;
  return { showBlastRadius: true, changedFiles, codebaseIndex };
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
 * Get a text priority badge aligned with a finding's severity
 * (`critical` → `P0`, `important` → `P1`, `minor` → `P2`). Unlike the emoji
 * badge, the text form is greppable and screen-reader friendly, so both are
 * rendered side by side.
 * @param severity - Severity of the issue.
 * @returns Priority text (`P0`/`P1`/`P2`).
 */
export function getSeverityPriority(severity: Severity): 'P0' | 'P1' | 'P2' {
  switch (severity) {
    case 'critical':
      return 'P0';
    case 'important':
      return 'P1';
    case 'minor':
      return 'P2';
  }
}

/**
 * Format a reachability suffix for a finding from its Reachability data.
 * Returns an empty string when the finding carries no Reachability signal so
 * callers render nothing instead of `Unknown` noise.
 * @param issue - Finding that may carry Reachability fields.
 * @returns ` · Reachable`, ` · Unreachable`, or `''`.
 */
export function formatReachabilityLabel(issue: ReviewIssue): string {
  try {
    if (issue.theoreticalRisk === true) return ' · Unreachable';
    if (issue.theoreticalRisk === false) return ' · Reachable';
    if (issue.entryPointPath || issue.entryPointFile) return ' · Reachable';
  } catch {
    // Fail-open: Reachability must never break rendering.
  }
  return '';
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
  const validated =
    typeof issue.validationEvidence === 'string' && issue.validationEvidence.trim() !== ''
      ? ' · ✅ Validated'
      : '';
  return `- ${getSeverityBadge(issue.severity)} **[${getSeverityPriority(issue.severity)}] ${issue.severity.toUpperCase()}:** \`${codePath}\` — ${sanitizeMarkdown(issue.message)}${formatConfidenceLabel(issue.confidence)}${formatReachabilityLabel(issue)}${validated}`;
}

/**
 * Input for {@link buildInlinePrelude}.
 */
export interface InlinePreludeInput {
  path: string;
  line: number;
  body: string;
}

/**
 * Build the 422-fallback prelude for an inline comment downgraded to a
 * body/notes comment (`**Inline comment (path:line)**\n\n<body>`).
 * Single source of truth for GitHub + GitLab `postReview` fallbacks.
 * Pure, fail-open (callers already try/catch the fallback post).
 * @param path - File path the inline comment anchors to.
 * @param line - Diff line the inline comment anchors to.
 * @param body - Original inline comment body, preserved verbatim.
 * @returns The fallback comment body.
 * @since NEXT
 */
export function buildInlinePrelude(path: string, line: number, body: string): string {
  return `**Inline comment (${path}:${line})**\n\n${body}`;
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
 * One-line summary of the gaps, for the banner under the trust statement.
 *
 * Kept separate from {@link formatTrustSection} because the two answer
 * different questions: this one is "what went wrong", the other is "give me
 * the table".
 * @param trust - Aggregated trust figures for the run.
 * @returns One-line summary of the coverage gaps.
 */
export function formatTrustDetail(trust: ReviewTrust): string {
  const parts: string[] = [];
  const unreadable = trust.passes.reduce((sum, p) => sum + p.unreadable, 0);
  const failed = trust.passes.filter((p) => p.outcome === 'failed');
  if (unreadable > 0) parts.push(`**${unreadable}** input(s) UNSCANNED`);
  for (const p of failed) parts.push(`\`${p.pass}\` failed`);
  if (trust.candidatesDropped > 0) {
    parts.push(`${trust.candidatesDropped} candidate finding(s) dropped`);
  }
  if (trust.findingRetention !== null) {
    parts.push(`${Math.round(trust.findingRetention * 100)}% of candidates published`);
  }
  if (trust.anchorsRangeChecked > 0) {
    parts.push(`${trust.anchorsRangeChecked} anchor(s) range-checked only`);
  }
  if (trust.staleAnchors > 0) parts.push(`**${trust.staleAnchors}** stale line anchor(s)`);
  return parts.length > 0 ? parts.join(' · ') : 'See the coverage table below.';
}

/**
 * Render the trust block as a per-pass table plus run-level figures.
 *
 * Every column here is a count of something that either happened or did not.
 * Nothing is inferred from tone or confidence, so a reader can check the
 * arithmetic — which is the whole point of putting it in the comment rather
 * than in a log the reader never sees.
 * @param trust - Aggregated trust figures for the run.
 * @returns The rendered trust section markdown.
 */
export function formatTrustSection(trust: ReviewTrust): string {
  const out: string[] = [];
  const sha = trust.headSha ? trust.headSha.slice(0, 7) : 'n/a (not PR-anchored)';
  out.push(`- **Computed against:** \`${sha}\``);
  // Issue #1008 attestation: name which tree was actually read. Full
  // verification counts ride on the trust block when the engine provided
  // them; older results without counts still state the claimed head SHA so
  // the absence of verification is visible rather than implied.
  try {
    const hasCounts =
      typeof trust.headContentExpected === 'number' &&
      typeof trust.headContentMaterialized === 'number';
    if (hasCounts) {
      const expected = trust.headContentExpected as number;
      const materialized = trust.headContentMaterialized as number;
      const overlayOn = trust.headContentOverlayConfigured !== false;
      if (!overlayOn) {
        out.push(
          `- **Reviewed tree:** \`${sha}\` (head-content overlay not configured — file reads fell back to the checkout)`,
        );
      } else if (expected <= 0) {
        out.push(`- **Reviewed tree:** \`${sha}\` (verified 0/0 blobs from head)`);
      } else if (materialized >= expected) {
        out.push(
          `- **Reviewed tree:** \`${sha}\` (verified ${materialized}/${expected} blobs from head)`,
        );
      } else {
        const missingCount = expected - materialized;
        const missing = Array.isArray(trust.headContentMissing)
          ? (trust.headContentMissing as string[]).slice(0, 5)
          : [];
        const more = missingCount > missing.length ? ', …' : '';
        const shown =
          missing.length > 0 ? `: ${missing.map((p) => `\`${p}\``).join(', ')}${more}` : '';
        out.push(
          `- **Reviewed tree:** \`${sha}\` (verified ${materialized}/${expected} blobs from head — **${missingCount} file(s) missing from the head overlay**${shown}; unverified files were NOT certified clean)`,
        );
      }
    } else {
      out.push(`- **Reviewed tree:** \`${sha}\``);
    }
  } catch {
    // Fail-open: attestation must never break the review render.
    out.push(`- **Reviewed tree:** \`${sha}\``);
  }
  out.push(`- **Exhaustive:** ${trust.exhaustive ? 'yes' : '**no** — see the gaps below'}`);

  if (trust.candidatesConsidered > 0) {
    const pct =
      trust.findingRetention === null ? 'unknown' : `${Math.round(trust.findingRetention * 100)}%`;
    out.push(
      `- **Candidates:** ${trust.candidatesConsidered} considered, ` +
        `${trust.candidatesDropped} dropped, ${pct} published`,
    );
  } else {
    out.push('- **Candidates:** not tracked for this run (retention unknown)');
  }

  out.push(
    `- **Unreadable inputs:** ${trust.unreadableInputs} (failed closed: ${
      trust.failedClosed ? 'yes — reported as UNSCANNED, not clean' : 'no'
    })`,
  );

  out.push(
    `- **Line anchors:** ${trust.anchorsChecked} verified (source line compared), ` +
      `${trust.anchorsRangeChecked} range-checked only, ${trust.staleAnchors} stale`,
  );

  out.push('');
  out.push('| Pass | Outcome | Read | Not read |');
  out.push('| --- | --- | ---: | ---: |');
  for (const p of trust.passes) {
    const label = p.outcome === 'findings' ? 'findings' : p.outcome;
    out.push(`| \`${p.pass}\` | ${label} | ${p.scanned} | ${p.unreadable} |`);
  }

  const reasons = trust.passes.filter((p) => p.reason?.trim());
  if (reasons.length > 0) {
    out.push('');
    for (const p of reasons) {
      out.push(`- \`${p.pass}\`: ${sanitizeMarkdown(p.reason as string)}`);
    }
  }

  return out.join('\n');
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
    // A total failure (every dispatched agent failed and nothing survived)
    // must not wear the "Partial review" label — nothing was reviewed.
    const totalAgents = result.totalAgents ?? result.failedAgents;
    const hasFindings = result.issues.length > 0 || result.strengths.length > 0;
    if (!hasFindings && result.failedAgents >= totalAgents) {
      lines.push(
        `> ⚠️ **Review failed** — all ${totalAgents} agent(s) failed; no findings were produced.`,
      );
    } else {
      lines.push(
        `> ⚠️ **Partial review** — ${result.failedAgents}/${totalAgents} agent(s) failed; findings may be missing.`,
      );
    }
    lines.push('');
  }

  // Condition 3 / the cross-cutting ask: the verdict states its own coverage
  // BEFORE anything else, because the reader's first question about a clean
  // review is "what did you actually look at" and the answer has to be on the
  // same screen as the verdict, not buried under it.
  if (result.trust && !result.trust.exhaustive) {
    lines.push(`> ⚠️ **${result.trust.statement}**`);
    lines.push('>');
    lines.push(formatTrustDetail(result.trust));
    lines.push('');
  }

  if (result.executiveSummary) {
    const es = result.executiveSummary;
    const riskEmoji = es.riskLevel === 'high' ? '🔴' : es.riskLevel === 'medium' ? '🟡' : '🟢';
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(`**Purpose:** ${capField(sanitizeMarkdown(es.purpose), EXEC_SUMMARY_FIELD_CAP)}`);
    lines.push('');
    lines.push(
      `**Risk:** ${riskEmoji} ${es.riskLevel.toUpperCase()} — ${capField(sanitizeMarkdown(es.riskRationale), EXEC_SUMMARY_FIELD_CAP)}`,
    );
    if (es.breakingChanges.length > 0) {
      lines.push('');
      lines.push('**Breaking Changes:**');
      for (const bc of es.breakingChanges) {
        lines.push(`- ⚠️ ${capField(sanitizeMarkdown(bc), 400)}`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push(
    '## MR Review Summary',
    '',
    capField(sanitizeMarkdown(result.summary), SUMMARY_FIELD_CAP),
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

  // Review-effort minutes estimate (default on, fail-open): resolve an
  // explicit override first, otherwise estimate from churn + findings. Any
  // failure omits the line and renders the rest of the comment.
  try {
    if (options?.showEffortEstimate !== false) {
      const minutes =
        options?.effortMinutes ??
        estimateReviewMinutes(options?.changedFilesForEffort, result.issues);
      const line = formatEffortMinutesLine(minutes);
      if (line) {
        lines.push(line);
        lines.push('');
      }
    }
  } catch (error) {
    new Logger('review-body').debug(
      `Omitting effort estimate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Author self-review checklist (default on, fail-open): static markdown
  // with no state dependency.
  try {
    if (options?.showSelfReviewChecklist !== false) {
      lines.push(formatSelfReviewChecklist());
      lines.push('');
    }
  } catch (error) {
    new Logger('review-body').debug(
      `Omitting self-review checklist: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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
    const budget = options?.maxVisibleFindings ?? options?.noiseBudget;
    const { visible: visibleIssues, spillover: budgetSpillover } = applyNoiseBudget(
      result.issues,
      budget,
    );
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
      if (typeof i.validationEvidence === 'string' && i.validationEvidence.trim() !== '') {
        // Shell-validation evidence (opt-in): validator stdout attached as
        // proof the finding reproduces. Sanitized — validator output is
        // untrusted subprocess text.
        const anchor = escapeInlineCode(`${i.file}:${i.line}`);
        lines.push(`<details><summary>Validation evidence for <code>${anchor}</code></summary>`);
        lines.push('');
        lines.push('```');
        lines.push(sanitizeMarkdown(i.validationEvidence.trim()).slice(0, 2048));
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

  // The coverage table itself, for readers who scroll past the banner. Always
  // rendered when a trust block exists — including on an exhaustive run, where
  // "everything was read" is itself the useful information.
  if (result.trust) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Review coverage');
    lines.push('');
    lines.push(formatTrustSection(result.trust));
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

  if (options?.showBlastRadius === true) {
    try {
      const section = buildBlastRadiusSection(options.changedFiles, options.codebaseIndex);
      if (section) {
        lines.push('');
        lines.push(section);
      }
    } catch (error) {
      // Fail-open: graph lookup must never break the review render.
      new Logger('review-body').debug(
        `Omitting blast radius section: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Layer 2 of the length defence, and the only one that can catch overflow
  // from the findings listing. Applied here so EVERY posting path is covered:
  // the github legacy path, the reviews-array path and the gitlab adapter all
  // build their body through this function.
  const capped = truncateReviewBody(lines.join('\n'));
  if (capped.truncated) options?.onTruncate?.(capped);
  return capped.body;
}

/**
 * GitHub's hard limit on `POST /pulls/{n}/reviews` body length.
 *
 * GitHub rejects a longer body with HTTP 422
 * `Body is too long (maximum is 65536 characters)`. Kept one below the wire
 * limit so a body that passes our check cannot be rejected for being exactly
 * at the boundary.
 */
export const GITHUB_REVIEW_BODY_LIMIT = 65535;

/** Default cap for the executive-summary fields, which model-authored text feeds. */
const EXEC_SUMMARY_FIELD_CAP = 3000;

/** Default cap for the consolidated summary block. */
const SUMMARY_FIELD_CAP = 8000;

/**
 * Cap one model-authored field, marking that it was clipped.
 *
 * Layer one of the length defence. Capping the unbounded fields BEFORE the
 * body is assembled is what guarantees the invariants the reviewer demanded:
 * the readiness line, the merge score and the risk rating are emitted from
 * fixed-size text, so they can never be the thing that gets cut.
 * @param text - The field text.
 * @param cap - Maximum characters to keep.
 * @returns The capped text, with an ellipsis when it was clipped.
 */
function capField(text: string, cap: number): string {
  if (typeof text !== 'string') return '';
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}… [clipped ${text.length - cap} chars]`;
}

/** Where the untruncated review body can be found, for the truncation marker. */
export const FULL_REVIEW_OUTPUT_HINT =
  'the full review is in this workflow run\'s job log (search for "Consolidated result"), and every finding is listed in the run summary';

/** Outcome of {@link truncateReviewBody}. */
export interface TruncatedReviewBody {
  /** The body to post; equals the input when it was already within the limit. */
  body: string;
  /** True when characters were removed. */
  truncated: boolean;
  /** Length of the body before truncation. */
  originalLength: number;
  /** How many characters were removed. */
  droppedChars: number;
}

/**
 * Clamp a review body to GitHub's limit, marking the cut loudly.
 *
 * A body chopped mid-sentence and posted as if complete is worse than no
 * review at all: it reads as a full review of code that was only partly
 * described. So the truncation is stated in the body itself, names the
 * original length, and points at the untruncated output.
 *
 * The HEAD is preserved because the verdict, `**Ready to merge?**`, the merge
 * score and the risk rating are all emitted early and are therefore never the
 * content that gets dropped. The cut is made at a line boundary so the last
 * visible line is not a fragment.
 * @param body - The fully assembled review body.
 * @param options - Optional limit override and output hint.
 * @param options.limit
 * @param options.fullOutputHint
 * @returns The body to post plus what was dropped.
 * @since NEXT
 */
export function truncateReviewBody(
  body: string,
  options?: { limit?: number; fullOutputHint?: string },
): TruncatedReviewBody {
  const limit = options?.limit ?? GITHUB_REVIEW_BODY_LIMIT;
  const originalLength = typeof body === 'string' ? body.length : 0;
  if (originalLength <= limit) {
    return { body, truncated: false, originalLength, droppedChars: 0 };
  }

  const hint = options?.fullOutputHint ?? FULL_REVIEW_OUTPUT_HINT;
  const marker =
    `\n\n---\n\n> ⚠️ **THIS REVIEW IS TRUNCATED.** GitHub rejects review bodies over ` +
    `${limit} characters; this one was ${originalLength}. It was cut to fit, so the findings ` +
    `listing below is **INCOMPLETE** — treat every count above as a floor, not a total.\n` +
    `> \n` +
    `> The **verdict**, the readiness line and the risk rating at the top are complete and ` +
    `unaffected — only the detail below the cut was dropped. ` +
    `${hint}.`;

  const budget = limit - marker.length;
  if (budget < 0) {
    // Pathologically small limit: keep the marker (the honest signal) and drop
    // the body rather than posting a >limit body GitHub will reject outright.
    return {
      body: marker.slice(0, limit),
      truncated: true,
      originalLength,
      droppedChars: originalLength,
    };
  }

  let head = body.slice(0, budget);
  // Prefer a line boundary so the final visible line is never a fragment.
  const lastBreak = head.lastIndexOf('\n');
  if (lastBreak > budget * 0.5) head = head.slice(0, lastBreak);

  const out = `${head}${marker}`;
  return {
    body: out,
    truncated: true,
    originalLength,
    droppedChars: originalLength - head.length,
  };
}

/** A single inline review comment, as batched into `comments[]`. */
export interface InlineCommentPayload {
  /** Repo-relative path. */
  path: string;
  /** Line number in the diff. */
  line: number;
  /** Diff side the comment anchors to. */
  side: string;
  /** Rendered comment markdown. */
  body: string;
}

/** Default maximum inline comments batched into one review request. */
export const DEFAULT_MAX_INLINE_COMMENTS = 50;

/** Default maximum characters for a single inline comment body. */
export const DEFAULT_MAX_INLINE_BODY = 8000;

/** Outcome of {@link capInlineComments}. */
export interface CappedInlineComments {
  /** Comments that survived, in order. */
  comments: InlineCommentPayload[];
  /** How many were dropped. */
  droppedCount: number;
  /** Paths of dropped comments, for the "what was dropped" line. */
  droppedPaths: string[];
  /** True when anything at all was dropped. */
  dropped: boolean;
}

/**
 * Cap the inline batch on both count and per-comment length.
 *
 * The batched `comments[]` request is the FIRST thing rejected when a review
 * is too large, and it fails before the summary-only fallback gets a chance.
 * So it needs its own cap, independent of the body cap.
 *
 * Dropping silently is the failure mode this exists to prevent: a PR that
 * generated 60 findings and received 42 comments with no statement of the
 * shortfall reads as a clean, complete review. The caller is handed the dropped
 * paths so the loss can be stated in the review body itself.
 * @param comments - The inline comments to cap.
 * @param options - Optional count/length overrides.
 * @param options.maxCount
 * @param options.maxBodyChars
 * @returns The surviving comments plus what was dropped.
 * @since NEXT
 */
export function capInlineComments(
  comments: InlineCommentPayload[],
  options?: { maxCount?: number; maxBodyChars?: number },
): CappedInlineComments {
  const maxCount = options?.maxCount ?? DEFAULT_MAX_INLINE_COMMENTS;
  const maxBodyChars = options?.maxBodyChars ?? DEFAULT_MAX_INLINE_BODY;
  const list = Array.isArray(comments) ? comments : [];

  const kept: InlineCommentPayload[] = [];
  const droppedPaths: string[] = [];
  let droppedCount = 0;

  for (const comment of list) {
    if (kept.length >= maxCount) {
      droppedCount++;
      droppedPaths.push(`${comment?.path ?? 'unknown'}:${comment?.line ?? '?'}`);
      continue;
    }
    const body = typeof comment?.body === 'string' ? comment.body : '';
    const clippedBody =
      body.length > maxBodyChars
        ? `${body.slice(0, maxBodyChars)}\n\n> ⚠️ This inline comment was **truncated** (${body.length} characters, cap ${maxBodyChars}). Full text in the job log.`
        : body;
    kept.push({ ...comment, body: clippedBody });
  }

  return { comments: kept, droppedCount, droppedPaths, dropped: droppedCount > 0 };
}

/**
 * Render the "what was dropped" line for dropped inline findings.
 * @param result - The outcome of {@link capInlineComments}.
 * @param maxPaths - How many dropped paths to enumerate before summarising.
 * @returns A markdown block, or an empty string when nothing was dropped.
 * @since NEXT
 */
export function formatDroppedInlineNotice(result: CappedInlineComments, maxPaths = 8): string {
  if (!result?.dropped) return '';
  const shown = result.droppedPaths.slice(0, maxPaths);
  const rest = result.droppedPaths.length - shown.length;
  const list = shown.map((p) => `  - \`${p}\``).join('\n');
  const more = rest > 0 ? `\n  - …and ${rest} more` : '';
  return (
    `\n> ⚠️ **${result.droppedCount} inline finding(s) were NOT posted.** GitHub rejects ` +
    `oversized review payloads, so the batch was capped at ` +
    `${keptCountLabel(result.comments.length)} comment(s). This review is therefore ` +
    `**INCOMPLETE**. These locations are in the review body above and in the job log, ` +
    `but have **no inline comment**:\n${list}${more}\n`
  );
}

/**
 * Human label for the number of inline comments actually posted.
 * @param kept - Number of inline comments that survived the cap.
 * @returns The count as a display string.
 */
function keptCountLabel(kept: number): string {
  return String(kept);
}
