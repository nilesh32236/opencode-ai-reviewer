/**
 * Shared helpers for slash-command handlers.
 *
 * Repository-slug validation and abort classification used by the command
 * router (`commands.ts`) and the per-command handler modules. Centralized
 * here so the split handler modules don't depend on the router, avoiding
 * an import cycle.
 */

import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { Logger } from '@opencode-pr-agent/lib';

/** Module-scope logger for helpers that have no per-call context. */
const logger = new Logger('CommandHelpers');

/**
 * Resolve a marker-based progress comment to its terminal state.
 *
 * Overwrites the existing comment identified by `marker` (creating it when it
 * no longer exists) so a status comment posted at the start of a long-running
 * command never stays in a permanent "in progress" state. Failures are logged
 * and swallowed: resolving a status comment must never break the command that
 * already produced a real outcome.
 * @param gh - Platform adapter.
 * @param issueNumber - Issue/PR number the status comment belongs to.
 * @param marker - Marker identifying the progress comment.
 * @param body - Terminal status body.
 */
export async function resolveProgressComment(
  gh: PlatformAdapter,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  try {
    await gh.postOrUpdateComment(issueNumber, marker, body);
  } catch (err) {
    logger.warn(
      `Failed to resolve progress comment ${marker} on #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Owner/repo slug pattern restricted to the GitHub/GitLab owner/repo charset
 * (alphanumerics, dot, dash, underscore) with one or more slash-separated
 * segments. Multiple segments support GitLab nested-group paths
 * (`group/subgroup/repo`); single-slash `owner/repo` is the GitHub form.
 * Rejects whitespace, backslashes, `..` segments, single-dot segments,
 * URL-confusing characters (`@`, `:`, `%`, control chars), and empty parts so
 * a webhook-supplied repo value can never escape into a crafted clone URL or
 * git remote.
 */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;

/**
 * Whether a repository slug is safe to interpolate into a clone/remote URL.
 * @param repo - Repository string in "owner/repo" (or GitLab nested-group) form.
 * @returns True when the slug matches slash-separated segments with no traversal.
 *
 * Exported for unit testing.
 */
export function isValidRepoSlug(repo: string): boolean {
  if (repo.includes('\\')) return false;
  if (!REPO_SLUG_PATTERN.test(repo)) return false;
  if (repo.includes('..')) return false;
  if (repo.split('/').some((p) => p === '.' || p === '')) return false;
  return true;
}

/**
 * Return true when an error represents cancellation: an aborted signal or an
 * `AbortError` (e.g. `signal.throwIfAborted()` thrown inside a try).
 * @param err - Error value to classify.
 * @param signal - Optional abort signal that marks cancellation when aborted.
 * @returns True when the error represents cancellation.
 */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}
