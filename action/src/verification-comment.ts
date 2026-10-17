/**
 * Verification-comment helpers extracted from `fix.ts` (god-module split).
 * Pure builders live here (dependency-light, unit-testable); `fix.ts`
 * re-exports them so existing import paths keep working. Side-effecting
 * posters stay in `fix.ts` where the engine/exec dependencies already live.
 */

/** Marker for the fail-closed verification-failure comment (upserted, never spammed). */
export const VERIFICATION_FAILED_MARKER = '<!-- autofix-verification-failed -->';

/** Max failing-output characters embedded in the verification-failed comment. */
export const VERIFICATION_FAILED_OUTPUT_LIMIT = 4000;

/** Fallback diagnostic when no failing-check output was captured. */
export const VERIFICATION_FAILED_FALLBACK =
  'Autofix verification failed (run_checks_after_fix did not pass after retries).';

/**
 * Build the fail-closed verification-failure comment body (pure, unit-tested).
 * Neutralizes triple-backtick sequences so attacker-controlled check output
 * cannot break out of the fenced block, caps output length, and falls back
 * to a diagnostic message when output is empty.
 * @param output - Failing check output (or rejection reason); already sanitized by callers.
 * @param extraNote - Optional extra context appended below the heading.
 * @returns Markdown comment body including the stable upsert marker.
 */
export function buildVerificationFailedCommentBody(output: string, extraNote?: string): string {
  const base = output || VERIFICATION_FAILED_FALLBACK;
  const trimmed =
    base.length > VERIFICATION_FAILED_OUTPUT_LIMIT
      ? `${base.slice(0, VERIFICATION_FAILED_OUTPUT_LIMIT)}\n…[truncated ${base.length - VERIFICATION_FAILED_OUTPUT_LIMIT} chars]…`
      : base;
  // Neutralize fence-breaking sequences: raw ``` in check output would close
  // the fenced block and render as arbitrary markdown (headings, links,
  // @mentions). U+02CB (modifier letter) looks like a backtick but is inert.
  const safe = trimmed.replace(/```/g, 'ˋˋˋ');
  const note = extraNote ? `\n\n${extraNote}` : '';
  return `${VERIFICATION_FAILED_MARKER}\n\n⚠️ **Autofix verification failed**\n\nThe configured \`run_checks_after_fix\` verification did not pass after retries. The pushed fix is unverified and needs manual review.${note}\n\n<details><summary>Failing check output</summary>\n\n\`\`\`\n${safe}\n\`\`\`\n\n</details>`;
}
