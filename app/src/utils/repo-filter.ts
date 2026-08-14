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
  /** True when ALLOWED_REPOS was set in the environment (even if all entries
   * were malformed). When set but empty, the filter must DENY everything
   * rather than fail open. */
  allowlistConfigured: boolean;
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
 *
 * Fail-closed allowlist semantics: when `ALLOWED_REPOS` is set but every entry
 * is malformed (e.g. no "owner/repo" slash), the parsed allowlist is empty but
 * `allowlistConfigured` stays true, so {@link isRepoAllowed} denies everything
 * instead of silently allowing all repos.
 * @param env - Environment variables (defaults to `process.env`).
 * @returns The parsed allowlist/denylist.
 */
export function buildRepoFilter(env: NodeJS.ProcessEnv = process.env): RepoFilter {
  const allowed = parseList(env.ALLOWED_REPOS);
  const denied = parseList(env.DENIED_REPOS);
  // Fail-closed: an allowlist that was configured but parsed to nothing (all
  // entries malformed) denies every repo instead of allowing all.
  const allowlistConfigured = (env.ALLOWED_REPOS ?? '').trim().length > 0;
  if (allowlistConfigured && allowed.size === 0) {
    logger.warn(
      'ALLOWED_REPOS is set but no valid "owner/repo" entries were parsed — denying all repositories (fail closed)',
    );
  }
  return { allowed, denied, allowlistConfigured };
}

/**
 * Shared process-wide repo filter, built once from the environment so every
 * handler/subscriber agrees on the same allowlist/denylist.
 */
export const repoFilter: RepoFilter = buildRepoFilter();

/**
 * Decide whether a repository is allowed to run heavy workloads.
 * A repo is allowed when: it is not on the denylist AND (the allowlist was
 * not configured OR it is on the allowlist). An allowlist that was configured
 * but parsed empty denies everything (fail closed).
 * @param repo - Repository in "owner/repo" form.
 * @param filter - The parsed repo filter.
 * @returns True when the repo may run heavy workloads.
 */
export function isRepoAllowed(repo: string | undefined, filter: RepoFilter): boolean {
  const normalized = repo?.toLowerCase() ?? '';
  if (!normalized) return false;
  if (filter.denied.has(normalized)) return false;
  if (filter.allowlistConfigured) return filter.allowed.has(normalized);
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
  if (filter.allowlistConfigured) {
    logger.warn('ALLOWED_REPOS configured but empty — all repositories denied');
  }
  if (filter.allowed.size === 0 && filter.denied.size === 0 && !filter.allowlistConfigured) {
    logger.info('No repo allowlist/denylist configured — all repositories are eligible');
  }
}
