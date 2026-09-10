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
