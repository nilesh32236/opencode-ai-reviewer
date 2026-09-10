import * as core from '@actions/core';
import * as github from '@actions/github';
import { sanitize } from './utils.js';

/**
 * Slash-commands that may trigger agent work when posted as a comment.
 * Mirrors the command set honored by the platform webhook receiver.
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
]);

/**
 * Extract the leading slash-command from a comment body, or null when the
 * body carries no known command. A leading '/' is required so bare words in
 * comments never count as commands.
 * @param body - The raw comment body (may be undefined for event payloads
 * without a comment).
 * @returns The lowercase command name, or null.
 */
export function extractCommentCommand(body: string | undefined | null): string | null {
  if (!body) return null;
  const trimmed = body.trim();
  if (!trimmed.startsWith('/')) return null;
  const command = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
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
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo: repoName,
      username: actor,
    });
    const permission = data.permission as string;
    if (permission === 'admin' || permission === 'write') {
      core.info(`Authorized issue_comment trigger from @${actor} (${permission})`);
      return true;
    }
    core.setFailed(
      `Refusing issue_comment trigger: @${actor} has '${permission}' permission (write access required)`,
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
