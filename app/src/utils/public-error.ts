/**
 * Fixed operator-facing text for public GitHub surfaces (PR/issue comments).
 *
 * Credential redaction is *not* information-disclosure redaction:
 * `sanitizeErrorMessage` removes tokens and API keys but deliberately keeps the
 * rest of the message, so absolute server paths, internal hostnames, git/API
 * internals, and attacker-influenced fragments of the triggering command body
 * all survive it. None of that belongs on a public comment, where anyone with
 * repository read access can read it — and forks/public repos can leak it
 * further.
 *
 * Public sinks therefore post only the fixed message from this module and keep
 * the sanitized detail in the structured log, matching the pattern already used
 * by `handleConversation`'s outer catch.
 */

/** Shown when a command fails before it produced a user-visible result. */
export const PUBLIC_GENERIC_FAILURE =
  'I encountered an error processing this request. Please try again or rephrase the command.';

/**
 * Build a public error comment body that discloses nothing about internals.
 *
 * @param summary - Operator-facing summary of what failed, e.g.
 * `'Changelog generation failed'`. Must describe the operation only — never
 * interpolate error text (or any other run-derived value) into it.
 * @param hint - Optional remediation sentence. Same constraint as `summary`.
 * @returns Markdown comment body safe to post to a public surface.
 */
export function publicErrorComment(summary: string, hint?: string): string {
  const body = summary.startsWith('❌') ? summary : `❌ **${summary}**`;
  const detail = hint ? ` ${hint}` : ` ${PUBLIC_GENERIC_FAILURE}`;
  return `${body}${detail}`;
}
