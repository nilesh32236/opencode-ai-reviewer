/**
 * Rough token estimate for a string (~4 chars per token).
 * @param text - The string to estimate token count for.
 * @returns Estimated token count (based on ~4 characters per token).
 */
export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}
