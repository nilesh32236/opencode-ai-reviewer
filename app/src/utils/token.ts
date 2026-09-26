/**
 * Get the GitHub token from the environment.
 *
 * Fail-closed: throws when no token is configured so callers never clone or
 * call the GitHub API with empty credentials. Prefer GitHub App installation
 * tokens (short-lived, per-installation scoped, rotated automatically) over a
 * single long-lived `GITHUB_TOKEN` where the deployment supports it.
 * @returns The GitHub token string.
 */
export function getToken(): string {
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set — all GitHub API calls will fail with 401');
  }
  return token;
}
