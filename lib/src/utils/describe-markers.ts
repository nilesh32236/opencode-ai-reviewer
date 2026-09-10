/**
 * Non-destructive PR-body merge helpers for `/describe`.
 *
 * Generated content is inserted/updated between stable markers; all user
 * content outside the markers is preserved byte-for-byte.
 */

/** Start marker delimiting the auto-generated describe section in the PR body. */
export const DESCRIBE_BODY_START = '<!-- opencode-describe:start -->';
/** End marker delimiting the auto-generated describe section in the PR body. */
export const DESCRIBE_BODY_END = '<!-- opencode-describe:end -->';

/**
 * Merge generated describe markdown into an existing PR body without
 * destroying human-written content.
 *
 * - If `existingBody` is null/empty, returns just the marker block.
 * - If markers are present, only the content between them is replaced.
 * - If markers are absent, the marker block is appended (never replaces body).
 * @param existingBody - Current PR body (may be null/undefined/empty).
 * @param generated - Generated describe markdown to place between markers.
 * @returns Merged PR body with user content preserved.
 */
export function mergeDescribeBody(
  existingBody: string | null | undefined,
  generated: string,
): string {
  // Strip marker strings echoed in generated content so LLM output can never
  // nest/spoof marker blocks or break out of the managed section.
  const clean = generated.split(DESCRIBE_BODY_START).join('').split(DESCRIBE_BODY_END).join('');
  const block = `${DESCRIBE_BODY_START}\n${clean}\n${DESCRIBE_BODY_END}`;
  const current = existingBody ?? '';
  if (current.trim() === '') {
    return block;
  }
  // Pair markers in order: the last START with the first END after it. A stray
  // END before the START is ignored, and a partial state (orphan START with no
  // closing END, or orphan END with no START) falls through to append so user
  // text is never spanned/deleted.
  const startIdx = current.lastIndexOf(DESCRIBE_BODY_START);
  const endIdx =
    startIdx !== -1
      ? current.indexOf(DESCRIBE_BODY_END, startIdx + DESCRIBE_BODY_START.length)
      : -1;
  if (startIdx !== -1 && endIdx !== -1) {
    const before = current.slice(0, startIdx);
    const after = current.slice(endIdx + DESCRIBE_BODY_END.length);
    return `${before}${block}${after}`;
  }
  // Markers absent (or malformed): append, preserving everything.
  const separator = current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${separator}${block}`;
}
