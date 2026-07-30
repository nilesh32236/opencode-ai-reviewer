import * as core from '@actions/core';
import * as github from '@actions/github';

/**
 * Sanitizes a message to prevent exposing secrets like Bearer tokens or API keys.
 * @param message - The raw message string.
 * @returns The sanitized string.
 */
export const sanitize = (message: string): string => {
  return message
    .replace(/(Bearer\s+)[a-zA-Z0-9._\-+/]+/gi, '$1***')
    .replace(/(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_]+/g, '***')
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, 'sk-***')
    .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1***');
};

/**
 * Resolves the PR number from the `pr-number` input or the GitHub event context.
 * Returns `null` when no PR number can be determined.
 */
export async function resolvePrNumber(): Promise<number | null> {
  const prNumberInput = core.getInput('pr-number');
  if (prNumberInput) {
    const prNumber = Number.parseInt(prNumberInput, 10);
    if (Number.isNaN(prNumber)) {
      core.setFailed(sanitize(`Invalid pr-number: ${prNumberInput}`));
      return null;
    }
    return prNumber;
  }
  const fromIssue = github.context.payload.issue?.number;
  const fromPR = github.context.payload.pull_request?.number;
  return fromPR || fromIssue || null;
}
