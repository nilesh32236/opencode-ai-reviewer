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
  /**
   * True when an allowlist was supplied but every entry was rejected as
   * malformed. Distinct from `allowed.size === 0`, which also covers "no
   * allowlist configured at all" (legitimately allow-all). Callers must treat
   * this as fail-closed.
   *
   * Optional so that a hand-built filter means the same as it always did: a
   * filter constructed without an allowlist allows everything.
   */
  allowlistInvalid?: boolean;
  /**
   * True when a denylist was supplied but every entry was rejected as
   * malformed. Same rationale as `allowlistInvalid`, and more consequential:
   * an entry dropped from a denylist is a repo that was meant to be excluded
   * and will run. Optional, for the same compatibility reason.
   */
  denylistInvalid?: boolean;
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
 *
 * A blank value counts as "not configured" rather than invalid, matching how an
 * unset environment variable is conventionally read. Both callers pass the same
 * string to the same `trim()`, so there is no gap between this definition of
 * "blank" and `parseList`'s: if `raw.trim()` is empty then no comma can be
 * present, so the single segment trims to empty and is dropped.
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
  // An operator who writes ALLOWED_REPOS meant to restrict this app to
  // specific repos. If every entry was malformed (a missing "owner/" is the
  // easy mistake), silently treating that as "no allowlist" would grant the
  // app access to every repo the account can see -- the opposite of the
  // intent, and the opposite of what the operator typed. Distinguish the two
  // and fail closed on the former.
  const allowlistInvalid = isInvalidList(env.ALLOWED_REPOS, allowed);
  // The denylist has the same typo class, and it is worse in one respect: a
  // dropped entry means a repo the operator explicitly excluded still runs. A
  // malformed denylist means we cannot know which repos were excluded, so
  // nothing can be safely processed.
  const denylistInvalid = isInvalidList(env.DENIED_REPOS, denied);
  return { allowed, denied, allowlistInvalid, denylistInvalid };
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
 *
 * An allowlist that was configured but produced no usable entries denies
 * everything: a typo must not widen access.
 * @param repo - Repository in "owner/repo" form.
 * @param filter - The parsed repo filter.
 * @returns True when the repo may run heavy workloads.
 */
export function isRepoAllowed(repo: string | undefined, filter: RepoFilter): boolean {
  const normalized = repo?.toLowerCase() ?? '';
  if (!normalized) return false;
  if (filter.denied.has(normalized)) return false;
  if (filter.allowlistInvalid) return false;
  // We cannot honour exclusions we failed to parse, so nothing is safe to run.
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
