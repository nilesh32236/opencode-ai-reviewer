/**
 * Sanitizes a message to prevent exposing secrets like Bearer tokens or API keys.
 * @param message - The raw message string.
 * @returns The sanitized string.
 */
export declare const sanitize: (message: string) => string;
/**
 * Resolves the PR number from the `pr-number` input or the GitHub event context.
 * Rejects non-integer, zero, negative, and excessively large values so they
 * never reach the issues/pulls APIs (which would leak internal errors).
 * @returns The PR number, or `null` when no PR number can be determined.
 */
export declare function resolvePrNumber(): Promise<number | null>;
/**
 * Strictly parse `CI_MERGE_REQUEST_IID` (GitLab MR IID) into a positive
 * integer. `Number()` alone accepts "", hex, scientific notation, floats
 * (truncated), and NaN/Infinity, which could route comments to the wrong MR.
 * @param raw - Raw IID string; defaults to `process.env.CI_MERGE_REQUEST_IID`.
 * @returns The MR IID, or `undefined` when unset or invalid (with a warning).
 */
export declare function resolveGitLabMrIid(raw?: string): number | undefined;
