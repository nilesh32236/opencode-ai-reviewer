/**
 * Repository allowlist / denylist filtering for the platform API.
 *
 * Mirrors `app/src/utils/repo-filter.ts`: an allowlist restricts which repos
 * may be enqueued for cost-incurring work (clone + LLM review), and a denylist
 * explicitly excludes specific ones. Both are opt-in — when neither is set,
 * every repo is processed. An allowlist/denylist that was configured but
 * yielded no usable entries fails closed (denies everything) so a typo cannot
 * silently widen access.
 */

import { Logger } from '@opencode-pr-agent/lib';

const logger = new Logger('RepoFilter');

/** Parsed repo filtering configuration. */
export interface RepoFilter {
  /** Repos (owner/repo, lowercased) allowed to run heavy work; empty = allow all. */
  allowed: Set<string>;
  /** Repos (owner/repo, lowercased) explicitly excluded; empty = deny none. */
  denied: Set<string>;
  /**
   * True when an allowlist was supplied but every entry was rejected as
   * malformed. Distinct from `allowed.size === 0` ("not configured").
   * Callers must treat this as fail-closed.
   */
  allowlistInvalid?: boolean;
  /**
   * True when a denylist was supplied but every entry was rejected as
   * malformed. Nothing can be safely processed in that case.
   */
  denylistInvalid?: boolean;
}

/**
 * Strict `owner/repo` shape check applied before the allowlist decision.
 * Rejects paths, URLs, empty segments, and whitespace so attacker input never
 * reaches the clone step unvalidated.
 * @param repo - Candidate repository slug.
 * @returns True when `repo` is exactly `owner/repo`.
 */
export function isValidRepoSlug(repo: string): boolean {
  // This must match the STRICT copy in lib/src/utils/validation.ts. The regex
  // alone is NOT sufficient: its character class includes '.', so '../..' and
  // 'a/..' both match it and would pass a boundary check whose comment claims
  // to reject traversal. The explicit '..' and '.'-segment checks below are
  // what actually make the promise true.
  if (typeof repo !== 'string' || repo.length === 0) return false;
  if (repo.includes('\\')) return false;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return false;
  if (repo.includes('..')) return false;
  if (repo.split('/').some((segment) => segment === '.' || segment === '')) return false;
  return true;
}

/**
 * Parse a raw comma-separated repo list into a normalized set.
 * Entries without a '/' are dropped, surrounding whitespace is trimmed,
 * and the remainder is lowercased for case-insensitive matching.
 * @param raw - Raw comma-separated list (e.g. from an env var).
 * @returns The parsed set of `owner/repo` slugs (empty when raw is empty).
 */
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
 * True when a raw list was supplied but produced no usable entries.
 * @param raw - The raw comma-separated list, or undefined when unset.
 * @param parsed - The set produced by `parseList` for that raw value.
 * @returns True when `raw` was non-blank but yielded no entries.
 */
function isInvalidList(raw: string | undefined, parsed: Set<string>): boolean {
  return typeof raw === 'string' && raw.trim().length > 0 && parsed.size === 0;
}

/**
 * Build the repo filter from environment variables.
 * @param env - Environment variables (defaults to `process.env`).
 * @returns The parsed allowlist/denylist.
 */
export function buildRepoFilter(env: NodeJS.ProcessEnv = process.env): RepoFilter {
  const allowed = parseList(env.ALLOWED_REPOS);
  const denied = parseList(env.DENIED_REPOS);
  const allowlistInvalid = isInvalidList(env.ALLOWED_REPOS, allowed);
  const denylistInvalid = isInvalidList(env.DENIED_REPOS, denied);
  return { allowed, denied, allowlistInvalid, denylistInvalid };
}

/**
 * Shared process-wide repo filter, built once from the environment so every
 * route agrees on the same allowlist/denylist.
 */
export const repoFilter: RepoFilter = buildRepoFilter();

/**
 * Decide whether a repository is allowed to run heavy workloads.
 * A repo is allowed when: it is not on the denylist AND (the allowlist is
 * empty OR it is on the allowlist). An invalid (fail-closed) list denies
 * everything.
 * @param repo - Repository in "owner/repo" form.
 * @param filter - The parsed repo filter.
 * @returns True when the repo may run heavy workloads.
 */
export function isRepoAllowed(repo: string | undefined, filter: RepoFilter): boolean {
  const normalized = repo?.toLowerCase() ?? '';
  if (!normalized) return false;
  if (filter.denied.has(normalized)) return false;
  if (filter.allowlistInvalid) return false;
  if (filter.denylistInvalid) return false;
  if (filter.allowed.size > 0) return filter.allowed.has(normalized);
  return true;
}

/**
 * Log which repos are filtered at startup so operators can verify the config.
 * @param filter - The parsed repo filter.
 */
export function logRepoFilter(filter: RepoFilter): void {
  if (filter.allowlistInvalid) {
    logger.error(
      'ALLOWED_REPOS was set but contained no valid "owner/repo" entries — ' +
        'denying every repository. Expected a comma-separated list such as ' +
        '"acme/api,acme/web".',
    );
  }
  if (filter.denylistInvalid) {
    logger.error(
      'DENIED_REPOS was set but contained no valid "owner/repo" entries — ' +
        'denying every repository, because the intended exclusions cannot be honoured. ' +
        'Expected a comma-separated list such as "acme/secret,acme/private".',
    );
  }
  if (filter.allowed.size > 0) {
    logger.info(`Repo allowlist: ${[...filter.allowed].sort().join(', ')}`);
  }
  if (filter.denied.size > 0) {
    logger.info(`Repo denylist: ${[...filter.denied].sort().join(', ')}`);
  }
  if (
    filter.allowed.size === 0 &&
    filter.denied.size === 0 &&
    !filter.allowlistInvalid &&
    !filter.denylistInvalid
  ) {
    logger.info('No repo allowlist/denylist configured — all repositories are eligible');
  }
}
