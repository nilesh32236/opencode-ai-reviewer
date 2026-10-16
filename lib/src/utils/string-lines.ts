/**
 * Utility for memory-efficient string splitting in hot paths.
 */

/**
 * Iterates over lines in a string without allocating an array of strings for
 * the entire payload (unlike `String.prototype.split('\\n')`).
 * This limits peak memory during generation but yielded string slices still pin
 * the underlying string, so callers must not retain the yielded strings unless
 * pinning the whole payload is acceptable.
 *
 * @param content - The multi-line string to iterate over.
 * @returns An iterator yielding each line as a string.
 */
export function* iterateLines(content: string): IterableIterator<string> {
  let lastIndex = 0;
  while (true) {
    const index = content.indexOf('\n', lastIndex);
    if (index === -1) {
      yield content.slice(lastIndex);
      break;
    }
    yield content.slice(lastIndex, index);
    lastIndex = index + 1;
  }
}
