export declare const sanitize: (message: string) => string;
/**
 * Resolves the PR number from the `pr-number` input or the GitHub event context.
 * Returns `null` when no PR number can be determined.
 */
export declare function resolvePrNumber(): Promise<number | null>;
