import { MAX_INSTRUCTION_EXTRACT_CHARS, OPERATOR_INSTRUCTION_TRUNCATION_MARKER } from '@opencode-pr-agent/lib';
export { OPERATOR_INSTRUCTION_TRUNCATION_MARKER };
/**
 * Slash-command events that must pass the authorization gate before any
 * privileged work runs. Covers issue comments, PR review comments, and
 * submitted PR reviews (whose bodies can also carry `/fix` / `/review`).
 */
export declare const GATED_COMMENT_EVENTS: Set<string>;
/**
 * Modes that must never run unauthenticated from a comment trigger.
 *
 * Every mode in this set performs writes with the repo token (git push,
 * createPR, createIssue, setLabels, or PR comments) or pays for a full LLM
 * run with label mutations, so the fail-closed substring-trigger guard in
 * index.ts applies uniformly. `audit` is intentionally NOT listed
 * statically: it is write-privileged only when `audit_create_issues` is true
 * (see {@link isWriteMode}) so the tokenless read-only split
 * (`audit_create_issues=false`, findings via the `audit_findings` output)
 * keeps working. `post`/`setup` never gate on comment triggers.
 */
export declare const PRIVILEGED_MODES: Set<string>;
/**
 * Whether a mode performs writes (or paid LLM work with repo mutations) and
 * must therefore pass the fail-closed comment-trigger permission check.
 * `audit` counts as a write mode only when issue creation is enabled; the
 * read-only split (`audit_create_issues=false`) emits `audit_findings` with
 * no GitHub writes and stays ungated.
 * @param mode - The action mode (e.g. `'fix'`).
 * @param auditCreateIssues - Value of the `audit_create_issues` input;
 * defaults to true (fail-closed) when the caller has not parsed inputs yet.
 * @returns True when the mode must never run unauthenticated from a comment.
 */
export declare function isWriteMode(mode: string | undefined, auditCreateIssues?: boolean): boolean;
/**
 * Deterministic, non-reversible short tag for a comment actor, used in logs
 * so workflow logs never persist raw GitHub usernames at info level
 * (PII-adjacent). The tag is stable within the repo so repeated triggers by
 * the same actor still correlate in the log without revealing the login.
 * @param actor - The GitHub login to redact.
 * @returns A short stable tag like `actor-1a2b`.
 */
export declare function redactActor(actor: string): string;
/**
 * Raw body of the triggering comment/review on gated comment events, or
 * undefined on non-comment events or when the payload carries no body.
 * Shared by the describe skip-bypass fix and the in-mode fail-closed
 * preconditions so body extraction cannot drift between call sites.
 * @returns The comment/review body, or undefined.
 */
export declare function getCommentTriggerBody(): string | undefined;
/**
 * Whether the current run was triggered by an explicit operator action
 * rather than an untrusted comment: `workflow_dispatch` / `schedule`
 * events, or an explicit `pr-number` / `comment-body` action input. Used by
 * the in-mode fail-closed preconditions so legitimate scheduled, manual,
 * and label-triggered flows never trip the comment-trigger guard.
 * @returns True when an explicit operator trigger is present.
 */
export declare function isExplicitOperatorTrigger(): boolean;
/**
 * Fail-closed precondition for non-privileged mode entry points
 * (analyze, docs, changelog, self-heal): on a gated comment event carrying
 * no recognized slash-command and no explicit operator trigger, the run
 * must not proceed to LLM work or repo writes — a stray non-command comment
 * would otherwise skip the index.ts gate entirely (null command +
 * non-privileged mode) and still execute unauthenticated.
 * @returns True when the caller must refuse to run (fail closed).
 */
export declare function shouldRefuseUnauthenticatedCommentTrigger(): boolean;
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
 * Maximum operator-instruction length (chars) accepted at extraction time.
 * Single owner lives in lib (`MAX_INSTRUCTION_EXTRACT_CHARS`); re-exported
 * here so existing import paths keep working.
 */
export declare const MAX_OPERATOR_INSTRUCTION_CHARS = 6000;
export { MAX_INSTRUCTION_EXTRACT_CHARS };
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
