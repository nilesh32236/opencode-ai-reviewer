import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  MAX_INSTRUCTION_EXTRACT_CHARS,
  OPERATOR_INSTRUCTION_TRUNCATION_MARKER,
  isPrivilegedPermissionLevel,
  resolveCommentAuthor,
  withRetry,
} from '@opencode-pr-agent/lib';

export { OPERATOR_INSTRUCTION_TRUNCATION_MARKER };
import { sanitize } from './utils.js';

/**
 * Slash-commands that may trigger agent work when posted as a comment.
 * Mirrors the command set honored by the platform webhook receiver.
 * Includes the '/oc' alias honored by production workflows.
 */
const COMMENT_COMMANDS = new Set([
  'review',
  'fix',
  'audit',
  'analyze',
  'docs',
  'describe',
  'changelog',
  'self-heal',
  'oc',
]);

/**
 * Slash-command events that must pass the authorization gate before any
 * privileged work runs. Covers issue comments, PR review comments, and
 * submitted PR reviews (whose bodies can also carry `/fix` / `/review`).
 */
export const GATED_COMMENT_EVENTS = new Set([
  'issue_comment',
  'pull_request_review_comment',
  'pull_request_review',
]);

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
export const PRIVILEGED_MODES = new Set([
  'fix',
  'review',
  'self-heal',
  'docs',
  'changelog',
  'analyze',
  'describe',
]);

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
export function isWriteMode(mode: string | undefined, auditCreateIssues = true): boolean {
  if (!mode) return false;
  if (PRIVILEGED_MODES.has(mode)) return true;
  return mode === 'audit' && auditCreateIssues;
}

/**
 * Deterministic, non-reversible short tag for a comment actor, used in logs
 * so workflow logs never persist raw GitHub usernames at info level
 * (PII-adjacent). The tag is stable within the repo so repeated triggers by
 * the same actor still correlate in the log without revealing the login.
 * @param actor - The GitHub login to redact.
 * @returns A short stable tag like `actor-1a2b`.
 */
export function redactActor(actor: string): string {
  let hash = 0;
  for (let i = 0; i < actor.length; i++) {
    hash = (hash * 31 + actor.charCodeAt(i)) | 0;
  }
  return `actor-${Math.abs(hash).toString(36)}`;
}

/**
 * Raw body of the triggering comment/review on gated comment events, or
 * undefined on non-comment events or when the payload carries no body.
 * Shared by the describe skip-bypass fix and the in-mode fail-closed
 * preconditions so body extraction cannot drift between call sites.
 * @returns The comment/review body, or undefined.
 */
export function getCommentTriggerBody(): string | undefined {
  const comment = github.context.payload.comment as { body?: unknown } | undefined;
  if (comment && typeof comment.body === 'string') return comment.body;
  const review = github.context.payload.review as { body?: unknown } | undefined;
  if (review && typeof review.body === 'string') return review.body;
  return undefined;
}

/**
 * Whether the current run was triggered by an explicit operator action
 * rather than an untrusted comment: `workflow_dispatch` / `schedule`
 * events, or an explicit `pr-number` / `comment-body` action input. Used by
 * the in-mode fail-closed preconditions so legitimate scheduled, manual,
 * and label-triggered flows never trip the comment-trigger guard.
 * @returns True when an explicit operator trigger is present.
 */
export function isExplicitOperatorTrigger(): boolean {
  const eventName = github.context.eventName;
  if (eventName === 'workflow_dispatch' || eventName === 'schedule') return true;
  try {
    const prNumberInput = core.getInput('pr-number') ?? '';
    if (String(prNumberInput).trim() !== '') return true;
    const commentBodyInput = core.getInput('comment-body') ?? '';
    if (String(commentBodyInput).trim() !== '') return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Fail-closed precondition for non-privileged mode entry points
 * (analyze, docs, changelog, self-heal): on a gated comment event carrying
 * no recognized slash-command and no explicit operator trigger, the run
 * must not proceed to LLM work or repo writes — a stray non-command comment
 * would otherwise skip the index.ts gate entirely (null command +
 * non-privileged mode) and still execute unauthenticated.
 * @returns True when the caller must refuse to run (fail closed).
 */
export function shouldRefuseUnauthenticatedCommentTrigger(): boolean {
  if (!GATED_COMMENT_EVENTS.has(github.context.eventName)) return false;
  if (isExplicitOperatorTrigger()) return false;
  return extractCommentCommand(getCommentTriggerBody() ?? '') === null;
}

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
export function extractCommentCommand(body: string | undefined | null): string | null {
  if (!body) return null;
  const m = body.match(
    /(?:^|\s)\/(review|fix|audit|analyze|docs|describe|changelog|self-heal|oc)\b/i,
  );
  if (!m) return null;
  const command = (m[1] ?? '').toLowerCase();
  return COMMENT_COMMANDS.has(command) ? command : null;
}

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
export function hasFixReReviewFlag(body: string | undefined | null): boolean {
  if (!body) return false;
  const token = /\b(re-review|re_review|rereview|force-review|force_review)\b/i;
  for (const line of String(body).split('\n')) {
    const fixMatch = line.match(/(?:^|\s)\/fix\b/i);
    if (fixMatch?.index !== undefined) {
      if (token.test(line.slice(fixMatch.index + fixMatch[0].length))) return true;
      continue;
    }
    const ocMatch = line.match(/(?:^|\s)\/oc\b/i);
    if (ocMatch?.index !== undefined) {
      const afterOc = line.slice(ocMatch.index + ocMatch[0].length);
      const innerFix = afterOc.match(/\bfix\b/i);
      if (innerFix?.index !== undefined) {
        if (token.test(afterOc.slice(innerFix.index + innerFix[0].length))) return true;
      }
    }
  }
  return false;
}

/**
 * Maximum operator-instruction length (chars) accepted at extraction time.
 * Single owner lives in lib (`MAX_INSTRUCTION_EXTRACT_CHARS`); re-exported
 * here so existing import paths keep working.
 */
export const MAX_OPERATOR_INSTRUCTION_CHARS = MAX_INSTRUCTION_EXTRACT_CHARS;

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
export function extractOperatorInstruction(body: string | undefined | null): string | undefined {
  if (body === undefined || body === null) return undefined;
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  // Presence guard: only bodies that actually carry a /fix (/oc alias) token
  // qualify — without it '/review do X' would be returned verbatim as a fix
  // instruction. Mirrors extractCommentCommand matching (mid-body, word
  // boundary, case-insensitive).
  if (!/(?:^|\s)\/(fix|oc)\b/i.test(trimmed)) return undefined;
  // Strip only the fix-trigger tokens (/fix and the /oc alias honored by
  // production workflows). Other slash-commands are left intact so their
  // text is not silently misclassified as a fix instruction.
  const withoutTokens = trimmed.replace(/(?:^|\s)\/(fix|oc)\b/gi, ' ');
  // Collapse excess blank lines left by token removal, then trim again.
  const collapsed = withoutTokens
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= MAX_OPERATOR_INSTRUCTION_CHARS) return collapsed;
  // Slice on a UTF-16 code-point boundary so truncation never splits a
  // surrogate pair (which would surface as U+FFFD in the prompt).
  let end = MAX_OPERATOR_INSTRUCTION_CHARS;
  const trailing = collapsed.charCodeAt(end - 1);
  if (trailing >= 0xd800 && trailing <= 0xdbff && end < collapsed.length) {
    end -= 1;
  }
  return `${collapsed.slice(0, end)}${OPERATOR_INSTRUCTION_TRUNCATION_MARKER}`;
}

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
export async function verifyCommentActorPermission(token: string): Promise<boolean> {
  // Fail-closed identity resolution shared with the app wrapper: when a
  // comment/review payload exists but names no author, no fallback to the
  // workflow actor is applied (that would trust the run author as if they
  // wrote the comment).
  const actor = resolveCommentAuthor(github.context.payload, github.context.actor);
  const { owner, repo: repoName } = github.context.repo;
  if (!actor) {
    core.setFailed('Refusing issue_comment trigger: could not determine comment author');
    return false;
  }
  try {
    const octokit = github.getOctokit(token);
    const { data } = await withRetry(
      () =>
        octokit.rest.repos.getCollaboratorPermissionLevel({
          owner,
          repo: repoName,
          username: actor,
        }),
      {
        maxRetries: 3,
        operationName: 'verifyCommentActorPermission',
        signal: AbortSignal.timeout(5000),
      },
    );
    const permission = data.permission as string;
    if (isPrivilegedPermissionLevel(permission)) {
      // Debug-level only: raw logins are PII-adjacent and info-level workflow
      // logs are retained; the redacted actor tag still correlates repeats.
      core.debug(
        sanitize(
          `Authorized ${github.context.eventName} trigger from ${redactActor(actor)} (${permission})`,
        ),
      );
      return true;
    }
    core.setFailed(
      sanitize(
        `Refusing ${github.context.eventName} trigger: ${redactActor(actor)} has '${permission}' permission (write access required)`,
      ),
    );
    return false;
  } catch (err) {
    core.setFailed(
      sanitize(
        `Refusing ${github.context.eventName} trigger: could not verify ${redactActor(actor)}'s permission (${err instanceof Error ? err.message : err})`,
      ),
    );
    return false;
  }
}
