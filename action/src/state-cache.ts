import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { restoreCache, saveCache } from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { CircuitBreaker, Logger, withRetry } from '@opencode-pr-agent/lib';
import { sanitize } from './utils.js';

/**
 * Maximum cache key length (GitHub Actions caps keys at 512 characters).
 */
const MAX_CACHE_KEY_LENGTH = 512;

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
 * Build a primary cache key for restore. Combines the prefix with the
 * repository NWO and branch ref so state cached for one branch is never
 * restored onto another. Falls back to the GitHub Actions context when the
 * repo or branch is not provided explicitly.
 *
 * @param prefix - Cache key prefix (e.g. `learning-state`).
 * @param repo - Repository in `owner/name` format; defaults to the GitHub context.
 * @param branch - Branch ref; defaults to the GitHub context ref without `refs/heads/`.
 * @param sha - Commit SHA; when provided, embedded in the key so each commit
 * gets an isolated cache entry. Omit for a stable branch-scoped key.
 * @returns The composite cache key string.
 */
export function buildCacheKey(
  prefix: string,
  repo?: string,
  branch?: string,
  sha?: string,
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
  const base = `${prefix}-${repoNwo}-${sanitizeBranchForCacheKey(branchRef)}`;
  const key = shaSegment ? `${base}-${shaSegment}` : base;
  return key.slice(0, MAX_CACHE_KEY_LENGTH);
}

/**
 * Options controlling which learning state the cache manager reads and writes.
 * All fields are optional and fall back to the GitHub Actions runtime context.
 */
export interface StateCacheManagerOptions {
  /** Directory that holds learning.db. Defaults to `.opencode` under cwd. */
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
 * cache. `save()` skips the write when the on-disk `learning.db` mtime is
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
  /** Cache key returned by the most recent successful restore (undefined when nothing was restored). */
  private restoredCacheKey: string | undefined;
  private readonly stateDir: string;
  private readonly cacheKeyPrefix: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly sha: string;
  private readonly logger: Logger;
  private savePromise: Promise<void> | undefined;
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

  private getLearningDbMtime(): number {
    const dbPath = path.join(this.stateDir, 'learning.db');
    try {
      return fs.statSync(dbPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private hashLearningDbContent(): string {
    const dbPath = path.join(this.stateDir, 'learning.db');
    try {
      const content = fs.readFileSync(dbPath);
      return createHash('sha256').update(content).digest('hex').slice(0, 16);
    } catch {
      return 'empty';
    }
  }

  /**
   * Restore the learning state from the Actions cache into `stateDir`.
   * Skips when the state directory already exists (it already holds a fresh
   * database for this run). Records the resolved cache key so `save()` can
   * derive a unique snapshot key instead of overwriting the restore key.
   *
   * @returns A promise that resolves when the restore attempt completes.
   */
  async restore(): Promise<void> {
    if (fs.existsSync(this.stateDir)) {
      core.info('.opencode/ directory already exists — skipping cache restore');
      this.learningDbMtimeMs = this.getLearningDbMtime();
      return;
    }

    core.info('Restoring learning state from cache...');
    const primaryKey = buildCacheKey(this.cacheKeyPrefix, this.repo, this.branch, this.sha);
    // Exact-key-only restore: a bare repo-wide prefix would let any ref
    // restore any other ref's cached state. The primary key already embeds
    // the full ref/SHA, so no fallback prefix is offered.
    const restoreKeys = [primaryKey];
    try {
      const cacheKey = await this.circuitBreaker.call(() =>
        withRetry(() => restoreCache([this.stateDir], primaryKey, restoreKeys), {
          operationName: 'state-cache.restore',
        }),
      );
      if (cacheKey) {
        this.restoredCacheKey = cacheKey;
        core.info(`Restored learning state from cache key: ${cacheKey}`);
      } else {
        core.info('No cached learning state found — starting fresh');
      }
    } catch (error) {
      const message = `Failed to restore learning state cache: ${error}`;
      core.warning(sanitize(message));
      this.logger.warn('Failed to restore learning state cache', {
        operation: 'cache.restore',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.learningDbMtimeMs = this.getLearningDbMtime();
  }

  /**
   * Save the learning state to the Actions cache.
   * Skips when the state directory or `learning.db` is absent, or when the db
   * mtime is unchanged from restore within a 1ms epsilon (saving happens only
   * when the difference exceeds 1ms). The save key is derived from the most
   * recent restore key plus a hash of the current db content, so repeated
   * saves produce unique snapshot keys rather than re-using (and colliding
   * with) the stable repository-and-branch key used for restore.
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

    const dbPath = path.join(this.stateDir, 'learning.db');
    if (!fs.existsSync(dbPath)) {
      core.info('No learning.db found — skipping cache save');
      return;
    }

    const currentMtime = this.getLearningDbMtime();
    if (currentMtime > 0 && Math.abs(currentMtime - this.learningDbMtimeMs) <= 1) {
      core.info('Learning state unchanged — skipping cache save');
      return;
    }

    const baseKey =
      this.restoredCacheKey ?? buildCacheKey(this.cacheKeyPrefix, this.repo, this.branch, this.sha);
    const cacheKey = `${baseKey}-${this.hashLearningDbContent()}`;
    try {
      await this.circuitBreaker.call(() =>
        withRetry(() => saveCache([this.stateDir], cacheKey), {
          operationName: 'state-cache.save',
        }),
      );
      core.info(`Saved learning state to cache key: ${cacheKey}`);
    } catch (error) {
      const message = `Failed to save learning state cache: ${error}`;
      core.warning(sanitize(message));
      this.logger.warn('Failed to save learning state cache', {
        operation: 'cache.save',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
