/**
 * Utility for memory-efficient string splitting in hot paths.
 */

/**
 * Iterates over lines in a string without allocating an array of strings for
 * the entire payload (unlike `String.prototype.split('\\n')`).
 * This prevents massive garbage collection overhead when parsing large inputs
 * like multi-megabyte JSONL files or diff payloads.
 *
 * @param content - The multi-line string to iterate over.
 * @returns A generator yielding each line as a string.
 */
export function* iterateLines(content: string): Generator<string> {
  let lastIndex = 0;
  while (true) {
    const index = content.indexOf('\n', lastIndex);
    if (index === -1) {
      yield content.substring(lastIndex);
      break;
    }
    yield content.substring(lastIndex, index);
    lastIndex = index + 1;
  }
}
