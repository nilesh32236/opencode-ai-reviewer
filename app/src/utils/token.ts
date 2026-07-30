/**
 * Get the GitHub token from the environment.
 * @returns The GitHub token string.
 */
export function getToken(): string {
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set — all GitHub API calls will fail with 401');
  }
  return token;
}
