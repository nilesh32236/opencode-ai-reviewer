/**
 * Rough token estimate based on a hybrid whitespace/symbol heuristic.
 * Prose and code tokenize differently, so a flat characters-per-token
 * ratio undercounts symbol-dense code and overcounts short prose.
 *
 * The floor is intentionally kept at the prior `Math.ceil(text.length / 4)`
 * heuristic so the estimator NEVER undershoots the legacy value: callers
 * (notably the conversation prompt budget guard) rely on `estimateTokens`
 * staying at or above the old estimate to avoid context-length overflows.
 * The hybrid divergence is strictly upward for code-heavy content.
 *
 * @param text - The string to estimate token count for.
 * @returns Estimated token count (words weighted 1.3, symbols weighted 0.4).
 */
export function estimateTokens(text: string): number {
  const symbolPattern = /[{};[\]()=<>+\-*/&|!0-9]/g;
  const words = text.trim().length > 0 ? text.trim().split(/\s+/) : [];
  const wordCount = words.length;
  const symbolCount = text.match(symbolPattern)?.length ?? 0;
  const estimate = Math.ceil(wordCount * 1.3 + symbolCount * 0.4);
  const floor = Math.ceil(text.length / 4);
  return Math.max(estimate, floor);
}
