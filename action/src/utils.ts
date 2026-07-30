import * as core from '@actions/core';
import * as github from '@actions/github';
import { sanitizeString } from '@opencode-pr-agent/lib';

export const sanitize = (message: string): string => sanitizeString(message);

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
