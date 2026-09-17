/**
 * Shared helpers for slash-command handlers.
 *
 * Repository-slug validation and abort classification used by the command
 * router (`commands.ts`) and the per-command handler modules. Centralized
 * here so the split handler modules don't depend on the router, avoiding
 * an import cycle.
 */

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
