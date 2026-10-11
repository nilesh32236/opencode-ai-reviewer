/**
 * Committable suggestion blocks for single-hunk fixes.
 *
 * The reviewer proposes code via GitHub's one-click ` ```suggestion ` fence
 * and never pushes or commits — the PR author stays in control. Additive and
 * guarded fail-open: anything ineligible (multi-hunk, over-long, disabled,
 * formatter error) falls back to a plain code fence or prose, and the
 * workflow still exits 0.
 * @since NEXT
 */

/** Maximum replacement lines for a one-click suggestion block. */
export const MAX_SUGGESTION_LINES = 20;

/** Render kind produced by {@link buildCommittableSuggestion}. */
export type SuggestionKind = 'suggestion' | 'code' | 'prose';

/** Input for {@link isSuggestionEligible} and {@link buildCommittableSuggestion}. */
export interface CommittableSuggestionInput {
  /** Raw replacement code (or free-form suggestion text). */
  code?: string;
  /** First line of the single exact-match range, when known. */
  startLine?: number;
  /** Last line of the single exact-match range (inclusive), when known. */
  endLine?: number;
  /** Diff hunk count covering the fix, when known. */
  hunkCount?: number;
  /** Master switch; false forces a non-committable render. Default true. */
  enabled?: boolean;
}

/** Output of {@link buildCommittableSuggestion}. */
export interface CommittableSuggestion {
  /** `suggestion` = committable fence, `code` = plain fence, `prose` = no code. */
  kind: SuggestionKind;
  /** Markdown block to append (empty when `kind` is `prose`). */
  body: string;
}

/**
 * Whether a raw replacement qualifies for a one-click suggestion fence:
 * single file/hunk, at most {@link MAX_SUGGESTION_LINES} lines, exact single
 * contiguous line range only. Never throws — unparsable input is ineligible.
 * Note: range/hunk context is best-effort — callers that do not know the
 * commented line range or hunk count pass code only, in which case the check
 * is line-count/marker based and a multi-range replacement may still render
 * a ` ```suggestion ` fence that GitHub refuses to apply (fail-open).
 * @param input - Candidate replacement plus optional range/hunk context.
 * @returns True when a ` ```suggestion ` fence is safe to emit.
 * @since NEXT
 */
export function isSuggestionEligible(input: CommittableSuggestionInput): boolean {
  try {
    if (input.enabled === false) return false;
    if (typeof input.code !== 'string') return false;
    const trimmed = input.code.trim();
    if (trimmed.length === 0) return false;
    const lines = trimmed.split('\n');
    if (lines.length > MAX_SUGGESTION_LINES) return false;
    if (typeof input.hunkCount === 'number' && input.hunkCount > 1) return false;
    // Multi-hunk / multi-file diff markers are never a single exact match.
    if (/^@@\s/m.test(trimmed) || /^diff\s+--git/m.test(trimmed)) return false;
    // Exact line match only: a known range must be a single contiguous span
    // within the suggestion cap.
    const { startLine, endLine } = input;
    if (startLine !== undefined || endLine !== undefined) {
      if (
        typeof startLine !== 'number' ||
        typeof endLine !== 'number' ||
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine ||
        endLine - startLine + 1 > MAX_SUGGESTION_LINES
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether free-form suggestion text is diff-shaped (`+`/`-` prefixes) as
 * opposed to raw replacement code. Conservative on purpose: single prefixed
 * lines such as bullets (`- fix`) or quantities (`+1`) are NOT diff — a diff
 * fence requires a `+`/`-` pair, or 2+ prefixed lines alongside a neutral
 * (context) line. Never throws.
 * @param text - Trimmed suggestion text.
 * @returns True when the text looks like a real diff hunk.
 * @since NEXT
 */
export function isDiffShaped(text: string): boolean {
  try {
    let plus = 0;
    let minus = 0;
    let other = 0;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('+')) plus += 1;
      else if (line.startsWith('-')) minus += 1;
      else other += 1;
    }
    const prefixed = plus + minus;
    if (prefixed === 0) return false;
    // Classic hunk: both sides present (e.g. `-old` / `+new`).
    if (plus > 0 && minus > 0) return true;
    // Pure-add / pure-remove hunk with surrounding context lines.
    if (prefixed >= 2 && other > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Strip runs of triple backticks so LLM-controlled code cannot break out of
 * the rendered fence (markdown/HTML injection into the posted comment).
 * Never throws — non-string input yields ''.
 */
function sanitizeFenceContent(code: string): string {
  try {
    return code.replace(/```+/g, '``');
  } catch {
    return '';
  }
}

/**
 * Build the markdown block for a proposed fix. Eligible single-hunk
 * replacements become a committable ` ```suggestion ` fence; diff-shaped or
 * over-long/multi-hunk input becomes a plain ` ```diff `/` ``` ` fence;
 * disabled input or formatter errors become `prose` (no code block). Never
 * throws and never pushes or commits.
 * @param input - Candidate replacement plus optional range/hunk context.
 * @returns The render kind and markdown body (empty when `prose`).
 * @since NEXT
 */
export function buildCommittableSuggestion(
  input: CommittableSuggestionInput,
): CommittableSuggestion {
  try {
    if (typeof input.code !== 'string' || input.code.trim().length === 0) {
      return { kind: 'prose', body: '' };
    }
    const code = input.code.trim();
    if (isDiffShaped(code)) {
      // Detection and rendering agree on trimmed prefixes so indented diff
      // lines (e.g. '  + foo') keep their sign; intentional blank lines are
      // preserved as empty lines instead of being dropped.
      const diffBody = code
        .split('\n')
        .map((l) => {
          if (l.trim().length === 0) return '';
          const t = l.trimStart();
          return t.startsWith('+') || t.startsWith('-') ? l : ` ${l}`;
        })
        .join('\n');
      return { kind: 'code', body: `\`\`\`diff\n${sanitizeFenceContent(diffBody)}\n\`\`\`` };
    }
    if (isSuggestionEligible(input)) {
      return {
        kind: 'suggestion',
        body: `\`\`\`suggestion\n${sanitizeFenceContent(code)}\n\`\`\``,
      };
    }
    if (code.length > 0) {
      return { kind: 'code', body: `\`\`\`\n${sanitizeFenceContent(code)}\n\`\`\`` };
    }
    return { kind: 'prose', body: '' };
  } catch {
    // Fail-open: prose fallback, workflow still exits 0.
    return { kind: 'prose', body: '' };
  }
}

/**
 * Resolve the `enable-suggestions` switch from boolean, string, or absent
 * input. Absent/invalid means enabled (fail-open, legacy output preserved).
 * @param value - Raw flag value from config, action input, or options.
 * @returns False only for an explicit false/`'false'`; true otherwise.
 * @since NEXT
 */
export function resolveEnableSuggestions(value: unknown): boolean {
  if (value === false) return false;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'false') return false;
  return true;
}
