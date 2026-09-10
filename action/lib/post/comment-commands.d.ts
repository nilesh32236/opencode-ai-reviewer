/**
 * Extract the leading slash-command from a comment body, or null when the
 * body carries no known command. A leading '/' is required so bare words in
 * comments never count as commands.
 * @param body - The raw comment body (may be undefined for event payloads
 * without a comment).
 * @returns The lowercase command name, or null.
 */
export declare function extractCommentCommand(body: string | undefined | null): string | null;
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
