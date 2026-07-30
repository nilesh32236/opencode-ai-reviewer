/**
 * Sanitizes a message to prevent exposing secrets like Bearer tokens or API keys.
 * @param message - The raw message string.
 * @returns The sanitized string.
 */
export declare const sanitize: (message: string) => string;
/**
 * Resolves the PR number from the `pr-number` input or the GitHub event context.
 * @returns The PR number, or `null` when no PR number can be determined.
 */
export declare function resolvePrNumber(): Promise<number | null>;
