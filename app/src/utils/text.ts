/**
 * Shared text/byte utilities for handlers.
 *
 * Byte-length helpers used to stay within GitHub API limits (e.g. the Checks
 * API output-text cap). Lives here — rather than inside a feature handler —
 * so unrelated handlers can share it without cross-handler coupling.
 */

/** Safety bound for check-run output text (GitHub caps it at 65535 bytes). */
export const MAX_CHECK_TEXT_BYTES = 60_000;

/**
 * Truncate a string so its UTF-8 encoding fits within `maxBytes` while keeping
 * the result valid UTF-8 (never splits a multi-byte character or surrogate
 * pair). The Checks API limits output text in bytes, so code-unit length alone
 * is insufficient.
 *
 * Uses a binary search over the code-unit length instead of the previous
 * char-by-char concatenation, turning an O(n²) encoding loop into O(log n)
 * encoding passes.
 * @param text - The text to truncate.
 * @param maxBytes - Maximum UTF-8 byte length (defaults to the check limit).
 * @returns The truncated text, or the original when it already fits.
 *
 * Exported for unit testing.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number = MAX_CHECK_TEXT_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  // Binary search for the largest code-unit prefix whose UTF-8 encoding fits.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  // The cut can land between a surrogate pair; back off one code unit so the
  // result never ends with a lone high surrogate (which UTF-8 encodes as U+FFFD).
  let end = lo;
  if (end > 0 && end < text.length) {
    const first = text.charCodeAt(end - 1);
    const second = text.charCodeAt(end);
    if (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) {
      end--;
    }
  }
  return text.slice(0, end);
}
