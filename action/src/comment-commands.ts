import * as core from '@actions/core';
import * as github from '@actions/github';
import { withRetry } from '@opencode-pr-agent/lib';
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
 * Maximum operator-instruction length (chars) forwarded to the fix agent.
 * Consistent with the prompt-builder section caps (tens of KB); deliberately
 * small so a pasted log cannot blow up the fix prompt.
 */
export const MAX_OPERATOR_INSTRUCTION_CHARS = 6000;

/** Marker appended when an operator instruction is truncated to the cap. */
export const OPERATOR_INSTRUCTION_TRUNCATION_MARKER = '\n\n[truncated]';

/**
 * Extract the operator instruction remainder from a triggering `/fix` comment.
 * Strips the `/fix` (and `/oc` alias) command token itself, trims whitespace,
 * and truncates to {@link MAX_OPERATOR_INSTRUCTION_CHARS} with an explicit
 * `[truncated]` marker.
 *
 * Returns `undefined` for empty input or for a bare command (`/fix` alone),
 * so no-comment triggers (label, dispatch, GitLab) behave exactly as today.
 * @param body - Raw comment body or explicit `comment-body` input value.
 * @returns The classified instruction text, or `undefined` when there is none.
 */
export function extractOperatorInstruction(body: string | undefined | null): string | undefined {
  if (body === undefined || body === null) return undefined;
  const trimmed = body.trim();
  if (!trimmed) return undefined;
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
 * Verify that the actor who triggered an `issue_comment` (or
 * `pull_request_review_comment`) event holds write/admin permission on the
 * repository before honoring manual commands (/fix, /analyze, manual
 * re-review). Fails closed: any lookup failure or a read/none permission
 * marks the action failed and returns false.
 * @param token - GitHub token used for the permission lookup.
 * @returns True when the actor is authorized to trigger the command.
 */
export async function verifyCommentActorPermission(token: string): Promise<boolean> {
  const actor =
    (github.context.payload.comment as { user?: { login?: string } } | undefined)?.user?.login ||
    github.context.actor;
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
      { maxRetries: 3, operationName: 'verifyCommentActorPermission' },
    );
    const permission = data.permission as string;
    if (permission === 'admin' || permission === 'write' || permission === 'maintain') {
      core.info(sanitize(`Authorized issue_comment trigger from @${actor} (${permission})`));
      return true;
    }
    core.setFailed(
      sanitize(
        `Refusing issue_comment trigger: @${actor} has '${permission}' permission (write access required)`,
      ),
    );
    return false;
  } catch (err) {
    core.setFailed(
      sanitize(
        `Refusing issue_comment trigger: could not verify @${actor}'s permission (${err instanceof Error ? err.message : err})`,
      ),
    );
    return false;
  }
}
