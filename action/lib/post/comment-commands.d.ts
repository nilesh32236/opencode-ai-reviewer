/**
 * Extract a slash-command from a comment body, or null when the body carries
 * no known command. Mirrors production workflow trigger semantics, which fire
 * on substring `contains(body, '/fix')` / `contains(body, '/review')` / '/oc':
 * the whole body is scanned (multiline) for a command token with a word
 * boundary, so mid-body commands like 'please /fix this' or 'Hi\n/fix' are
 * still gated for authorization instead of bypassing the check.
 * @param body - The raw comment body (may be undefined for event payloads
 * without a comment).
 * @returns The lowercase command name, or null.
 */
export declare function extractCommentCommand(body: string | undefined | null): string | null;
/**
 * Whether a `/fix` trigger comment explicitly asks for a fresh review.
 * Additive helper — `extractCommentCommand` intentionally drops args, so the
 * autofix loop uses this to honor `/fix re-review` / `/fix re_review` /
 * `/fix force-review` (and the `/oc fix …` alias form) without changing the
 * auth gate. Only tokens on the same line as the command count, so quoted
 * docs or code snippets elsewhere in the body cannot force an expensive
 * fresh pass.
 * @param body - Raw comment body (may be undefined/null).
 * @returns True when a re-review token follows the fix command on its line.
 */
export declare function hasFixReReviewFlag(body: string | undefined | null): boolean;
/**
 * Verify that the actor who triggered an `issue_comment` (or
 * `pull_request_review_comment`) event holds write/admin permission on the
 * repository before honoring manual commands (/fix, /analyze, manual
 * re-review). Fails closed: any lookup failure or a read/none permission
 * marks the action failed and returns false.
 * @param token - GitHub token used for the permission lookup.
 * @returns True when the actor is authorized to trigger the command.
 */
export declare function verifyCommentActorPermission(token: string): Promise<boolean>;
