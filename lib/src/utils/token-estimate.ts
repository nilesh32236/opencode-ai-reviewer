/**
 * Rough token estimate based on a hybrid whitespace/symbol heuristic.
 * Prose and code tokenize differently, so a flat characters-per-token
 * ratio undercounts symbol-dense code and overcounts short prose.
 * @param text - The string to estimate token count for.
 * @returns Estimated token count (words weighted 1.3, symbols weighted 0.4).
 */
export function estimateTokens(text: string): number {
  const symbolPattern = /[{};[\]()=<>+\-*/&|!0-9]/g;
  const words = text.trim().length > 0 ? text.trim().split(/\s+/) : [];
  const wordCount = words.length;
  const symbolCount = text.match(symbolPattern)?.length ?? 0;
  const estimate = Math.ceil(wordCount * 1.3 + symbolCount * 0.4);
  const floor = Math.ceil(text.length / 6);
  return Math.max(estimate, floor);
}
