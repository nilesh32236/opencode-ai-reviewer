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
 * @param existingBody - Current PR body (may be null/empty).
 * @param generated - Generated describe markdown to place between markers.
 * @returns Merged PR body with user content preserved.
 */
export function mergeDescribeBody(existingBody: string | null, generated: string): string {
  const block = `${DESCRIBE_BODY_START}\n${generated}\n${DESCRIBE_BODY_END}`;
  const current = existingBody ?? '';
  if (current.trim() === '') {
    return block;
  }
  const startIdx = current.indexOf(DESCRIBE_BODY_START);
  const endIdx = current.indexOf(DESCRIBE_BODY_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = current.slice(0, startIdx);
    const after = current.slice(endIdx + DESCRIBE_BODY_END.length);
    return `${before}${block}${after}`;
  }
  // Markers absent (or malformed): append, preserving everything.
  const separator = current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${separator}${block}`;
}
