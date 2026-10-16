/**
 * Committable GitHub suggestion blocks for single-hunk fixes.
 *
 * A GitHub ```suggestion fence renders as a one-click "Apply suggestion"
 * button, but only when the replacement maps cleanly onto the anchored diff
 * range. This module guards that: a suggestion is only emitted for a single
 * file, single hunk, at most {@link MAX_SUGGESTION_LINES} replacement lines,
 * with an exact anchor match when the diff context is available.
 *
 * The reviewer only ever *proposes* code — it never pushes or commits. Every
 * renderer routes through {@link buildCommittableSuggestion}, which is
 * fail-open: ineligible or malformed input degrades to a plain code fence or
 * prose-only finding instead of throwing.
 *
 * @since NEXT
 */

import { Logger } from '../utils/logger.js';

const logger = new Logger('suggestions');

/**
 * Maximum number of replacement lines accepted for a committable suggestion.
 * Larger fixes fall back to a plain code fence.
 * @since NEXT
 */
export const MAX_SUGGESTION_LINES = 20;

/**
 * Input describing a candidate committable suggestion.
 * @since NEXT
 */
export interface SuggestionEligibilityInput {
  /** Raw replacement code the model proposed. */
  suggestionCode?: string;
  /** 1-based line the finding is anchored to (required for eligibility). */
  line?: number;
  /** Optional 1-based inclusive end of the replaced range (defaults to `line`). */
  endLine?: number;
  /**
   * Number of distinct diff hunks the fix spans. Anything greater than 1
   * falls back to a plain fence. Defaults to 1.
   */
  hunkCount?: number;
  /** Master switch (per finding). `false` disables suggestion blocks entirely. */
  enabled?: boolean;
  /** Repo-relative file path (used with `diffLines` for the exact-match check). */
  file?: string;
  /**
   * Diff line keys (`"path:line"`) used to verify the anchor is present in the
   * diff. When absent/empty the exact-match check is skipped (fail-open).
   */
  diffLines?: ReadonlySet<string>;
}

/**
 * Rendered suggestion outcome.
 * @since NEXT
 */
export interface CommittableSuggestion {
  /** `suggestion` = committable fence, `code` = plain fence, `prose` = no body. */
  kind: 'suggestion' | 'code' | 'prose';
  /** Rendered markdown body (empty for `prose`). */
  body: string;
  /** True only when a committable ```suggestion fence was emitted. */
  eligible: boolean;
}

/**
 * Whether a candidate qualifies for a committable suggestion block: enabled,
 * non-empty replacement code of at most {@link MAX_SUGGESTION_LINES} lines,
 * a single hunk, a valid anchor range, and — when diff context is supplied —
 * the anchor line present in the diff. Never throws.
 *
 * @param input - Candidate suggestion metadata.
 * @returns True when a committable ```suggestion fence is safe to emit.
 * @since NEXT
 */
export function isSuggestionEligible(input: SuggestionEligibilityInput): boolean {
  if (input?.enabled === false) return false;
  const code = typeof input?.suggestionCode === 'string' ? input.suggestionCode.trim() : '';
  if (code.length === 0) return false;
  const lineCount = code.split('\n').length;
  if (lineCount < 1 || lineCount > MAX_SUGGESTION_LINES) return false;

  if (typeof input.hunkCount === 'number' && input.hunkCount > 1) return false;

  const start = input.line;
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 1) return false;
  const end =
    typeof input.endLine === 'number' && Number.isFinite(input.endLine) ? input.endLine : start;
  if (!Number.isFinite(end) || end < start) return false;
  if (end - start + 1 > MAX_SUGGESTION_LINES) return false;

  // Exact anchor match, only when a non-empty diff context is available.
  const diffLines = input.diffLines;
  if (diffLines && diffLines.size > 0 && typeof input.file === 'string' && input.file.length > 0) {
    const key = `${input.file.replace(/^\//, '')}:${start}`;
    if (!diffLines.has(key)) return false;
  }
  return true;
}

/**
 * Render a candidate committable suggestion. Eligible fixes produce a
 * ```suggestion fence (exact replacement); ineligible fixes fall back to a
 * plain code fence so the code is still visible without exposing a one-click
 * apply button; malformed input degrades to `prose` (empty body). Never
 * throws and never pushes.
 *
 * @param input - Candidate suggestion metadata.
 * @returns The rendered {@link CommittableSuggestion}.
 * @since NEXT
 */
export function buildCommittableSuggestion(
  input: SuggestionEligibilityInput,
): CommittableSuggestion {
  try {
    // Deliberately non-optional access so a null/undefined `input` throws into
    // the prose fallback below rather than silently emitting nothing.
    const raw = input.suggestionCode;
    const code = typeof raw === 'string' ? raw.trim() : '';
    if (code.length === 0) return { kind: 'prose', body: '', eligible: false };
    if (isSuggestionEligible(input)) {
      return { kind: 'suggestion', body: `\`\`\`suggestion\n${code}\n\`\`\``, eligible: true };
    }
    return { kind: 'code', body: `\`\`\`\n${code}\n\`\`\``, eligible: false };
  } catch (error) {
    // Fail-open: a formatter error must never break the review; the caller
    // renders the finding as prose and the run still exits 0.
    logger.warn(
      `Suggestion formatter failed (prose fallback): ${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: 'prose', body: '', eligible: false };
  }
}
