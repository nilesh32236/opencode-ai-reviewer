import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { restoreCache, saveCache } from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { CircuitBreaker, Logger, withRetry } from '@opencode-pr-agent/lib';
import { sanitize, sanitizeErrorMessage } from './utils.js';

/**
 * Maximum cache key length (GitHub Actions caps keys at 512 characters).
 */
const MAX_CACHE_KEY_LENGTH = 512;

/**
 * Schema/version segment embedded in every state-cache key.
 *
 * The Actions cache is immutable and keyed by string with prefix matching on
 * restore, so a format change must mint a NEW key space rather than reuse the
 * old one: a restore-key prefix would otherwise happily hand back a snapshot
 * written in an older format. Bumping this segment retires every legacy entry
 * by construction (their keys lack the segment) instead of relying on
 * post-restore content validation alone.
 */
const STATE_CACHE_SCHEMA_VERSION = 'v2';

/**
 * Maximum `learning.json` size that is fully parsed to validate it.
 *
 * Parsing is a validation step, not the mechanism (the state is consumed by
 * `LearningStore`), so an oversized file is accepted structurally rather than
 * parsed: a full parse of an unbounded file blocks the event loop and spikes
 * heap proportionally to state size on both `restore()` and `save()`.
 */
const MAX_JSON_VALIDATE_BYTES = 8 * 1024 * 1024;

/**
 * Sanitize a branch ref for embedding in a cache key. Branches are
 * PR-author-controlled and may contain slashes, dots, colons, spaces, or
 * "../" segments that cause collisions or poisoning across refs. Invalid
 * characters are replaced, the slug is truncated, and a short content hash
 * is appended whenever the slug was transformed so distinct branches never
 * collapse to the same key.
 *
 * @param branch - Raw branch ref.
 * @returns A safe, bounded slug with a disambiguating hash suffix when needed.
 */
export function sanitizeBranchForCacheKey(branch: string): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  if (slug === branch) return slug;
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 12);
  return `${slug}-${hash}`;
}

/**
 * Options for {@link buildCacheKey}.
 */
export interface BuildCacheKeyOptions {
  /**
   * Fixed-length disambiguating hash of `repo` + `branch`, appended right
   * after the branch slug and BEFORE any SHA segment.
   *
   * It terminates the key with a bounded, non-empty segment, which is what
   * makes "no other ref's key is a prefix-extension of this one" structural
   * instead of a property of the backend: a plain `<prefix>-<repo>-<slug>`
   * restore key is a strict prefix of `<prefix>-<repo>-<slug>-<other>`, so a
   * backend that resolved restore keys by prefix without per-branch scoping
   * would let one ref restore another's state. Hex-only for the same reason the
   * SHA is: it cannot inject key structure or collide across refs.
   */
  refTerminator?: string;
}

/**
 * Build a cache key. Combines the prefix with the repository NWO and branch
 * ref so state cached for one branch is never restored onto another. Falls
 * back to the GitHub Actions context when the repo or branch is not provided
 * explicitly.
 *
 * @param prefix - Cache key prefix (e.g. `learning-state`).
 * @param repo - Repository in `owner/name` format; defaults to the GitHub context.
 * @param branch - Branch ref; defaults to the GitHub context ref without `refs/heads/`.
 * @param sha - Commit SHA; when provided, embedded in the key so each commit
 *   gets an isolated cache entry. Omit for a branch-scoped key — the restore
 *   key MUST omit it, since a commit-scoped restore key can never be hit again
 *   (see {@link StateCacheManager.restore}).
 * @param options - Optional {@link BuildCacheKeyOptions}.
 * @returns The composite cache key string.
 */
export function buildCacheKey(
  prefix: string,
  repo?: string,
  branch?: string,
  sha?: string,
  options?: BuildCacheKeyOptions,
): string {
  const repoNwo = repo || `${github.context.repo.owner}/${github.context.repo.repo}`;
  const branchRef = branch || github.context.ref.replace('refs/heads/', '');
  // Note: env/context SHAs are resolved by StateCacheManager and passed
  // explicitly. A direct call without `sha` stays branch-scoped so existing
  // callers and tests keep stable keys.
  const rawSha = sha ?? '';
  // Full ref/SHA segment: a bare repo-wide prefix lets one ref restore
  // another's cached state (cache poisoning). The SHA is commit-scoped and
  // hex-only so it cannot collide across refs or inject key structure.
  const shaSegment = rawSha.replace(/[^a-fA-F0-9]/g, '').slice(0, 40);
  // Same sanitisation for the optional ref terminator so both key builders
  // share ONE definition of how segments are encoded.
  const terminatorSegment = (options?.refTerminator ?? '')
    .replace(/[^a-fA-F0-9]/g, '')
    .slice(0, 40);
  const base = `${prefix}-${repoNwo}-${sanitizeBranchForCacheKey(branchRef)}`;
  const scopedBase = terminatorSegment ? `${base}-${terminatorSegment}` : base;
  const key = shaSegment ? `${scopedBase}-${shaSegment}` : scopedBase;
  return key.slice(0, MAX_CACHE_KEY_LENGTH);
}

/**
 * Active learning-state backend file on disk. `db` is the SQLite database
 * (`learning.db`); `json` is the JSON fallback (`learning.json`) used when the
 * `better-sqlite3` native binding cannot load (e.g. inside the ncc bundle on
 * CI). See `connectDb` in `lib/src/learning/db/sql-adapter.ts`.
 */
export interface ActiveStateFile {
  kind: 'db' | 'json';
  path: string;
}

/**
 * Derive the JSON-fallback path from a `.db` path. Mirrors the single source
 * of truth in `connectDb` (`lib/src/learning/db/sql-adapter.ts`):
 * `dbPathOrUrl.replace(/\.db$/, '.json')`.
 *
 * @param dbPath - Absolute path to `learning.db`.
 * @returns Absolute path to the sibling `learning.json`.
 */
export function deriveJsonStatePath(dbPath: string): string {
  return dbPath.endsWith('.db') ? dbPath.replace(/\.db$/, '.json') : dbPath;
}

/**
 * Options controlling which learning state the cache manager reads and writes.
 * All fields are optional and fall back to the GitHub Actions runtime context.
 */
export interface StateCacheManagerOptions {
  /** Directory that holds learning state (`learning.db` or `learning.json`). Defaults to `.opencode` under cwd. */
  stateDir?: string;
  /** Repository NWO. Defaults to the GitHub Actions context. */
  repo?: string;
  /** Branch ref. Defaults to the GitHub Actions context. */
  branch?: string;
  /** Commit SHA. Defaults to GITHUB_SHA / the GitHub context. */
  sha?: string;
}

/**
 * Manages the round-trip of the `.opencode` learning state through the Actions
 * cache. `save()` skips the write when the on-disk active state file
 * (`learning.db`, or the `learning.json` JSON fallback) mtime is
 * unchanged from the value captured at `restore()`, compared with a 1ms
 * epsilon. The epsilon (instead of strict equality) tolerates the sub-millisecond
 * mtime jitter filesystems report between stat calls.
 *
 * Restore and save calls run through a shared {@link CircuitBreaker} and
 * {@link withRetry} so transient backend failures are retried and repeated
 * failures short-circuit subsequent cache operations. A failure never throws:
 * both operations log a warning and degrade gracefully.
 */
export class StateCacheManager {
  private learningDbMtimeMs = 0;
  private readonly stateDir: string;
  private readonly cacheKeyPrefix: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly sha: string;
  private readonly logger: Logger;
  private savePromise: Promise<void> | undefined;
  /**
   * Content hash of the last successfully saved snapshot. Skipping saves
   * when the hash is unchanged bounds Actions-cache growth (GitHub caps the
   * cache at 10 GB and each unique `${baseKey}-${hash}` key is an additional
   * entry): repeated runs with identical db content reuse the existing entry
   * instead of minting a duplicate snapshot key.
   */
  private lastSavedContentHash: string | undefined;
  private readonly circuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    successThreshold: 2,
    cooldownMs: 30000,
    name: 'StateCache',
  });

  /**
   * Create a state cache manager.
   *
   * @param cacheKeyPrefix - Prefix used for both restore and save cache keys.
   * @param options - Optional stateDir, repo, and branch overrides.
   */
  constructor(cacheKeyPrefix: string, options: StateCacheManagerOptions = {}) {
    this.cacheKeyPrefix = cacheKeyPrefix;
    this.stateDir = options.stateDir ?? path.resolve(process.cwd(), '.opencode');
    this.repo = options.repo ?? `${github.context.repo.owner}/${github.context.repo.repo}`;
    this.branch = options.branch ?? github.context.ref.replace('refs/heads/', '');
    this.sha = options.sha ?? process.env.GITHUB_SHA ?? github.context.sha ?? '';
    this.logger = new Logger('StateCache', { repo: this.repo, branch: this.branch });
  }

  private getStateFileMtime(statePath: string): number {
    try {
      return fs.statSync(statePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Fixed-length hash of repo+branch, embedded in BOTH the restore key and the
   * snapshot key (see {@link buildRestoreKey}). It terminates the key, so no
   * other ref's key can be a prefix-extension of it and a backend that
   * resolves restore keys purely by prefix can never hand one ref's learning
   * state to another.
   *
   * @returns A 12-char hex hash of `repo` + `branch`.
   */
  private buildRefTerminator(): string {
    return createHash('sha256')
      .update(`${this.repo}\u0000${this.branch}`)
      .digest('hex')
      .slice(0, 12);
  }

  /**
   * Stable, branch-scoped restore key: `<prefix>-<schema>-<repo>-<branch>-<refHash>`.
   *
   * Deliberately EXCLUDES the commit SHA. The SHA used to be part of this
   * key, which made the feature structurally unable to restore: every new
   * commit minted a key nothing had ever saved under, and `restoreKeys` had
   * no looser prefix to fall back to, so learning state (dismissals, feedback
   * signals, suppression rules, telemetry) was re-created from scratch on
   * every run while `save()` grew the cache with unreadable entries toward
   * the 10 GB repository cap.
   *
   * Cross-ref poisoning stays impossible twice over: the repo AND the
   * sanitized branch slug are both part of the key, and the trailing
   * `refHash` makes the key non-prefix-extendable by construction rather than
   * relying on @actions/cache and GitLab both scoping cache visibility per
   * branch. Legacy (pre-version) entries are excluded by the `v2` segment, so
   * a stale-format snapshot can never be restored into a run expecting the
   * current format.
   *
   * @returns The branch-scoped restore key.
   */
  private buildRestoreKey(): string {
    return buildCacheKey(
      `${this.cacheKeyPrefix}-${STATE_CACHE_SCHEMA_VERSION}`,
      this.repo,
      this.branch,
      undefined,
      { refTerminator: this.buildRefTerminator() },
    );
  }

  /**
   * Snapshot key for `save()`: the branch-scoped restore key plus the commit
   * SHA, so each commit keeps its own immutable snapshot entry that the next
   * run's prefix-matched restore can find. Delegates to {@link buildCacheKey}
   * (rather than appending to `buildRestoreKey()` by hand) so the two builders
   * cannot drift apart: the snapshot key MUST be the restore key plus the SHA
   * segment, and a partial edit of one that missed the other would silently
   * reinstate the permanent-cache-miss bug. The SHA is HEX-only and cannot
   * inject key structure, and is stripped when absent.
   *
   * @returns The per-commit snapshot key.
   */
  private buildSnapshotKey(): string {
    return buildCacheKey(
      `${this.cacheKeyPrefix}-${STATE_CACHE_SCHEMA_VERSION}`,
      this.repo,
      this.branch,
      this.sha,
      { refTerminator: this.buildRefTerminator() },
    );
  }

  /**
   * Mtime of whichever backend file currently exists on disk (db preferred
   * when both are present), without validation or quarantine. Used to capture
   * the post-restore baseline exactly like the legacy db-only path did.
   *
   * @returns Mtime in milliseconds of the active state file, or 0 when neither backend file exists.
   */
  private getCurrentStateMtime(): number {
    const dbPath = path.join(this.stateDir, 'learning.db');
    try {
      return fs.statSync(dbPath).mtimeMs;
    } catch {
      // Fall through to the JSON fallback below.
    }
    try {
      return fs.statSync(deriveJsonStatePath(dbPath)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Hash the active state file content without loading the whole file into memory.
   * Streams the file through SHA-256 so a large DB does not spike heap on
   * every save. Only called after the mtime fast-path already detected a
   * change, so hashing runs solely when the state was actually modified.
   * @param statePath - Absolute path to the active state file to hash.
   * @returns Hex SHA-256 of the file content (empty string on read failure).
   */
  private async hashStateFileContent(statePath: string): Promise<string> {
    try {
      const hash = createHash('sha256');
      await pipeline(fs.createReadStream(statePath), hash);
      return hash.digest('hex').slice(0, 16);
    } catch {
      return 'empty';
    }
  }

  /**
   * Detect which learning-state backend file (if any) holds usable state.
   * Prefers `learning.db` when it is valid; otherwise falls back to
   * `learning.json` (the `connectDb` JSON fallback used when the
   * `better-sqlite3` native binding cannot load in the bundled action/CI).
   * Corrupt files are quarantined (unlinked) so `LearningStore` never opens
   * them and restore can fetch fresh state from cache. Unlink (do not rename
   * in place): `saveCache` uploads the whole stateDir, so a leftover
   * `*.corrupt-*` file would be preserved in cache snapshots and bloat every
   * future save.
   *
   * Reads asynchronously: this runs on both `restore()` and `save()`, so a
   * synchronous full-file read would block the event loop twice per run (once
   * per call) for state that can grow without bound.
   *
   * @returns The active backend file, or null when no usable state exists.
   */
  private async resolveActiveStateFile(): Promise<ActiveStateFile | null> {
    const dbPath = path.join(this.stateDir, 'learning.db');
    try {
      const st = fs.statSync(dbPath);
      if (st.isFile() && st.size > 100) {
        const fd = fs.openSync(dbPath, 'r');
        try {
          const header = Buffer.alloc(16);
          fs.readSync(fd, header, 0, 16, 0);
          if (header.toString('utf-8').startsWith('SQLite format 3')) {
            return { kind: 'db', path: dbPath };
          }
        } finally {
          fs.closeSync(fd);
        }
        // Corrupt db: quarantine so LearningStore never opens it.
        try {
          fs.unlinkSync(dbPath);
        } catch {
          /* ignore quarantine failure — detection proceeds anyway */
        }
      }
    } catch {
      /* absent db — fall through to the JSON fallback */
    }

    const jsonPath = deriveJsonStatePath(dbPath);
    try {
      const st = fs.statSync(jsonPath);
      if (st.isFile() && st.size > 0) {
        // A full parse is only a validation step, so it is skipped above the
        // cap: the state file is written by the learning store (it parses, or
        // there is no state to protect) and `learning.json` reaching 8 MiB
        // would itself be the anomaly worth surfacing rather than a reason to
        // discard the file and start from scratch. Below the cap the parse
        // still runs (asynchronously) so a corrupt file is quarantined.
        if (st.size > MAX_JSON_VALIDATE_BYTES) {
          core.warning(
            `learning.json is ${st.size} bytes (over the ${MAX_JSON_VALIDATE_BYTES}-byte validation cap) — accepting it without a full parse`,
          );
          return { kind: 'json', path: jsonPath };
        }
        try {
          JSON.parse(await fs.promises.readFile(jsonPath, 'utf-8'));
          return { kind: 'json', path: jsonPath };
        } catch {
          // Unparseable JSON: quarantine like a corrupt db.
          try {
            fs.unlinkSync(jsonPath);
          } catch {
            /* ignore quarantine failure — detection proceeds anyway */
          }
          return null;
        }
      }
      if (st.isFile() && st.size === 0) {
        // Zero-byte JSON holds no state: quarantine it.
        try {
          fs.unlinkSync(jsonPath);
        } catch {
          /* ignore quarantine failure */
        }
      }
    } catch {
      /* absent json — no usable state */
    }
    return null;
  }

  /**
   * Restore the learning state from the Actions cache into `stateDir`.
   * Skips when the state directory already holds a valid `learning.db` or
   * `learning.json` backend file for this run.
   *
   * The restore key is branch-scoped (no commit SHA) so it actually hits
   * across runs: `save()` writes `<branchScopedKey>-<sha>-<contentHash>`, and
   * the Actions cache matches restore keys by prefix, so the most recent
   * snapshot for this repo+branch is found even though the exact key never
   * exists. The repo and the sanitized branch slug are both embedded, so no
   * other ref can restore this state, and the `v2` segment keeps
   * stale-format snapshots out.
   *
   * @returns A promise that resolves when the restore attempt completes.
   */
  async restore(): Promise<void> {
    // Skip only when a usable state is already present. A pre-existing empty
    // directory (e.g. a checkout artifact) without usable state holds nothing,
    // so restore must still proceed instead of silently starting fresh.
    // The db is validated as a non-empty regular file with a SQLite header and
    // the json fallback as a non-empty regular file that parses as JSON, so a
    // zero-byte/corrupt file from a failed save never disables restore and
    // perpetuates corruption downstream.
    const active = await this.resolveActiveStateFile();
    if (active && fs.existsSync(this.stateDir)) {
      core.info(
        `.opencode/learning.${active.kind} already exists and is valid — skipping cache restore`,
      );
      this.learningDbMtimeMs = this.getStateFileMtime(active.path);
      return;
    }

    core.info('Restoring learning state from cache...');
    const primaryKey = this.buildRestoreKey();
    // Prefix fallback scoped to repo+branch. GitHub matches restore keys by
    // prefix and picks the most recently created match, which is exactly the
    // newest snapshot for this ref. A bare `prefix-repo-` key is deliberately
    // NOT offered: that would let one ref restore another ref's state.
    const restoreKeys = [primaryKey];
    try {
      const cacheKey = await this.circuitBreaker.call(() =>
        withRetry(() => restoreCache([this.stateDir], primaryKey, restoreKeys), {
          operationName: 'state-cache.restore',
        }),
      );
      if (cacheKey) {
        core.info(`Restored learning state from cache key: ${cacheKey}`);
      } else {
        core.info('No cached learning state found — starting fresh');
      }
    } catch (error) {
      const message = `Failed to restore learning state cache: ${error}`;
      core.warning(sanitize(message));
      this.logger.warn('Failed to restore learning state cache', {
        operation: 'cache.restore',
        error: sanitizeErrorMessage(error),
      });
    }

    this.learningDbMtimeMs = this.getCurrentStateMtime();
  }

  /**
   * Save the learning state to the Actions cache.
   * Skips when the state directory or both backend files (`learning.db`,
   * `learning.json`) are absent, when the active file mtime is unchanged
   * from restore within a 1ms epsilon (saving happens only when the
   * difference exceeds 1ms), or when the streamed content hash matches the
   * last saved snapshot (bounds cache growth toward distinct content states
   * instead of one entry per run). The save key is the branch-scoped restore
   * key plus the commit SHA plus a hash of the current state content, so every
   * snapshot is unique and immutable while remaining discoverable by the next
   * run's prefix-matched restore.
   *
   * @returns A promise that resolves when the save attempt completes.
   */
  async save(): Promise<void> {
    if (this.savePromise) return this.savePromise;

    const savePromise = this.saveState();
    this.savePromise = savePromise;
    try {
      await savePromise;
    } finally {
      if (this.savePromise === savePromise) {
        this.savePromise = undefined;
      }
    }
  }

  private async saveState(): Promise<void> {
    if (!fs.existsSync(this.stateDir)) {
      core.info('No learning state directory found — skipping cache save');
      return;
    }

    const active = await this.resolveActiveStateFile();
    if (!active) {
      core.info('No learning state file found (.db/.json) — skipping cache save');
      return;
    }
    core.info(`Active learning state backend: learning.${active.kind}`);

    const currentMtime = this.getStateFileMtime(active.path);
    if (currentMtime > 0 && Math.abs(currentMtime - this.learningDbMtimeMs) <= 1) {
      core.info('Learning state unchanged — skipping cache save');
      return;
    }

    const contentHash = await this.hashStateFileContent(active.path);
    if (this.lastSavedContentHash !== undefined && contentHash === this.lastSavedContentHash) {
      core.info('Learning state content unchanged since last save — skipping cache save');
      return;
    }
    const baseKey = this.buildSnapshotKey();
    const cacheKey = `${baseKey}-${contentHash}`.slice(0, MAX_CACHE_KEY_LENGTH);
    try {
      await this.circuitBreaker.call(() =>
        withRetry(() => saveCache([this.stateDir], cacheKey), {
          operationName: 'state-cache.save',
        }),
      );
      this.lastSavedContentHash = contentHash;
      this.learningDbMtimeMs = currentMtime;
      core.info(`Saved learning state to cache key: ${cacheKey}`);
    } catch (error) {
      const message = `Failed to save learning state cache: ${error}`;
      core.warning(sanitize(message));
      this.logger.warn('Failed to save learning state cache', {
        operation: 'cache.save',
        error: sanitizeErrorMessage(error),
      });
    }
  }
}
