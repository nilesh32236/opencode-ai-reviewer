import type { ReviewResult } from '@opencode-pr-agent/lib';

/**
 * Format a review result as a JSON document (pretty-printed).
 * @param result - Review result to serialize.
 * @returns A JSON string representation of the result.
 */
export function formatJson(result: ReviewResult): string {
  return JSON.stringify(result, null, 2);
}
