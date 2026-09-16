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
 * Maximum operator-instruction length (chars) forwarded to the fix agent.
 * Consistent with the prompt-builder section caps (tens of KB); deliberately
 * small so a pasted log cannot blow up the fix prompt.
 */
export declare const MAX_OPERATOR_INSTRUCTION_CHARS = 6000;
/** Marker appended when an operator instruction is truncated to the cap. */
export declare const OPERATOR_INSTRUCTION_TRUNCATION_MARKER = "\n\n[truncated]";
/**
 * Extract the operator instruction remainder from a triggering `/fix` comment.
 * Strips the `/fix` (and `/oc` alias) command token itself, trims whitespace,
 * and truncates to {@link MAX_OPERATOR_INSTRUCTION_CHARS} with an explicit
 * `[truncated]` marker.
 *
 * Returns `undefined` for empty input, for a bare command (`/fix` alone),
 * or when the body contains no `/fix` (`/oc` alias) token, so non-fix text
 * (e.g. `/review do X`) is never misclassified as a fix instruction and
 * no-comment triggers (label, dispatch, GitLab) behave exactly as today.
 * @param body - Raw comment body or explicit `comment-body` input value.
 * @returns The classified instruction text, or `undefined` when there is none.
 */
export declare function extractOperatorInstruction(body: string | undefined | null): string | undefined;
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
