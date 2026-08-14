/**
 * Repository allowlist / denylist filtering for the Probot app.
 *
 * The app is installed per-GitHub-account and may receive webhooks from many
 * repositories. An allowlist restricts which repos trigger reviews/fixes/audits
 * (so a single account install never spends paid-model budget on unintended
 * repos), and a denylist explicitly excludes specific ones. Both are opt-in:
 * when neither is set, every repo is processed.
 */

import { Logger } from '@opencode-pr-agent/lib';

const logger = new Logger('RepoFilter');

/** Parsed repo filtering configuration. */
export interface RepoFilter {
  /** Repos (owner/repo) allowed to trigger heavy runs; empty = allow all. */
  allowed: Set<string>;
  /** Repos (owner/repo) explicitly excluded; empty = deny none. */
  denied: Set<string>;
}

function parseList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.includes('/'))
      .map((s) => s.toLowerCase()),
  );
}

/**
 * Build the repo filter from environment variables.
 * @param env - Environment variables (defaults to `process.env`).
 * @returns The parsed allowlist/denylist.
 */
export function buildRepoFilter(env: NodeJS.ProcessEnv = process.env): RepoFilter {
  return {
    allowed: parseList(env.ALLOWED_REPOS),
    denied: parseList(env.DENIED_REPOS),
  };
}

/**
 * Shared process-wide repo filter, built once from the environment so every
 * handler/subscriber agrees on the same allowlist/denylist.
 */
export const repoFilter: RepoFilter = buildRepoFilter();

/**
 * Decide whether a repository is allowed to run heavy workloads.
 * A repo is allowed when: it is not on the denylist AND (the allowlist is
 * empty OR it is on the allowlist).
 * @param repo - Repository in "owner/repo" form.
 * @param filter - The parsed repo filter.
 * @returns True when the repo may run heavy workloads.
 */
export function isRepoAllowed(repo: string | undefined, filter: RepoFilter): boolean {
  const normalized = repo?.toLowerCase() ?? '';
  if (!normalized) return false;
  if (filter.denied.has(normalized)) return false;
  if (filter.allowed.size > 0) return filter.allowed.has(normalized);
  return true;
}

/**
 * Log which repos are filtered at startup so operators can verify the config.
 * @param filter - The parsed repo filter.
 */
export function logRepoFilter(filter: RepoFilter): void {
  if (filter.allowed.size > 0) {
    logger.info(`Repo allowlist: ${[...filter.allowed].sort().join(', ')}`);
  }
  if (filter.denied.size > 0) {
    logger.info(`Repo denylist: ${[...filter.denied].sort().join(', ')}`);
  }
  if (filter.allowed.size === 0 && filter.denied.size === 0) {
    logger.info('No repo allowlist/denylist configured — all repositories are eligible');
  }
}
