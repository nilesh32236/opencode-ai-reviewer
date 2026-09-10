import * as core from '@actions/core';
import * as github from '@actions/github';
import { sanitizeString } from '@opencode-pr-agent/lib';

/**
 * Sanitizes a message to prevent exposing secrets like Bearer tokens or API keys.
 * @param message - The raw message string.
 * @returns The sanitized string.
 */
export const sanitize = (message: string): string => sanitizeString(message);

/**
 * Maximum valid PR/issue number (signed 32-bit int, matching GitHub's range).
 */
const MAX_PR_NUMBER = 2147483647;

/**
 * Resolves the PR number from the `pr-number` input or the GitHub event context.
 * Rejects non-integer, zero, negative, and excessively large values so they
 * never reach the issues/pulls APIs (which would leak internal errors).
 * @returns The PR number, or `null` when no PR number can be determined.
 */
export async function resolvePrNumber(): Promise<number | null> {
  const prNumberInput = core.getInput('pr-number').trim();
  if (prNumberInput) {
    const trimmed = prNumberInput;
    // Require a canonical integer string: parseInt alone would accept "12abc"
    // or "1.5" (truncating to 1), so verify the round-trip first. This also
    // rejects partially-numeric values that would route against the wrong PR.
    const prNumber = Number.parseInt(trimmed, 10);
    if (
      Number.isNaN(prNumber) ||
      !Number.isInteger(prNumber) ||
      String(prNumber) !== trimmed ||
      prNumber < 1 ||
      prNumber > MAX_PR_NUMBER
    ) {
      core.setFailed(sanitize(`Invalid pr-number: ${prNumberInput}`));
      return null;
    }
    return prNumber;
  }
  const fromIssue = github.context.payload.issue?.number;
  const fromPR = github.context.payload.pull_request?.number;
  return fromPR || fromIssue || null;
}
