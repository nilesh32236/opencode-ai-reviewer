/**
 * Slash-command events that must pass the authorization gate before any
 * privileged work runs. Covers issue comments, PR review comments, and
 * submitted PR reviews (whose bodies can also carry `/fix` / `/review`).
 */
export declare const GATED_COMMENT_EVENTS: Set<string>;
/** Modes that must never run unauthenticated from a comment trigger. */
export declare const PRIVILEGED_MODES: Set<string>;
/**
 * Extract a slash-command from a comment body, or null when the body carries
 * no known command. The whole body is scanned (multiline) for a command token
 * with a word boundary, so mid-body commands like 'please /fix this' or
 * 'Hi\n/fix' are still gated for authorization instead of bypassing the check.
 *
 * SECURITY NOTE (fail-closed): workflow triggers use substring
 * `contains(body, '/fix')` semantics, which also fire on text like 'a/fix'
 * that this strict `(?:^|\s)\/` regex deliberately does NOT recognize (to
 * avoid false-positive auth prompts on paths/URLs). Callers must therefore
 * never treat a null return on a comment event in a privileged mode as
 * "no command, skip auth" — index.ts requires permission whenever a comment
 * event reaches a privileged mode, even when no recognized command extracts.
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
 * Verify that the actor who triggered an `issue_comment`,
 * `pull_request_review_comment`, or `pull_request_review` event holds
 * write/admin permission on the repository before honoring manual commands
 * (/fix, /analyze, manual re-review). Also covers explicit `comment-body`
 * inputs on non-comment events (where the workflow actor is checked).
 * Fails closed: any lookup failure or a read/none permission marks the
 * action failed and returns false.
 * @param token - GitHub token used for the permission lookup.
 * @returns True when the actor is authorized to trigger the command.
 */
export declare function verifyCommentActorPermission(token: string): Promise<boolean>;
