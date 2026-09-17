import type { PlatformAdapter } from '../platform/adapter.js';
import { GitHubHelper } from './github.js';
import { GitLabAdapter } from './gitlab-adapter.js';

/**
 * Single owner for the `config.platform === 'gitlab' ? GitLab : GitHub`
 * adapter selection, previously triplicated across 10+ `app/` handlers.
 * Adding a platform, auth param, or logging wrapper now requires one edit.
 *
 * Mirrors the historical ternary exactly: `'gitlab'` selects GitLab,
 * anything else (including undefined) selects GitHub.
 *
 * @param token - Platform authentication token.
 * @param repo - Repository slug (`owner/repo` or `group/project`).
 * @param platform - Platform name (`'gitlab'` selects GitLab, else GitHub).
 * @returns A `PlatformAdapter` for the requested platform.
 */
export function createPlatformAdapter(
  token: string,
  repo: string,
  platform?: string,
): PlatformAdapter {
  if (platform === 'gitlab') return new GitLabAdapter(token, repo);
  return new GitHubHelper(token, repo);
}
