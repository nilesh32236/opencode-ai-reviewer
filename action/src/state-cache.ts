import fs from 'fs';
import path from 'path';
import { restoreCache, saveCache } from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { Logger } from '@opencode-pr-agent/lib';
import { sanitize } from './utils.js';

/**
 * Build a cache key for the learning state.
 * @param prefix - Cache key prefix.
 * @param repo - Repository in `owner/name` form. Defaults to the GitHub Actions context.
 * @param branch - Branch ref. Defaults to the GitHub Actions context.
 * @returns The assembled cache key.
 */
export function buildCacheKey(prefix: string, repo?: string, branch?: string): string {
  const repoNwo = repo || `${github.context.repo.owner}/${github.context.repo.repo}`;
  const branchRef = branch || github.context.ref.replace('refs/heads/', '');
  return `${prefix}-${repoNwo}-${branchRef}`;
}

/** Options for configuring the state cache manager. */
export interface StateCacheManagerOptions {
  /** Directory that holds learning.db. Defaults to `.opencode` under cwd. */
  stateDir?: string;
  /** Repository NWO. Defaults to the GitHub Actions context. */
  repo?: string;
  /** Branch ref. Defaults to the GitHub Actions context. */
  branch?: string;
}

/**
 * Manages the round-trip of the `.opencode` learning state through the Actions
 * cache. `save()` skips the write when the on-disk `learning.db` mtime is
 * unchanged from the value captured at `restore()`, compared with a 1ms
 * epsilon. The epsilon (instead of strict equality) tolerates the sub-millisecond
 * mtime jitter filesystems report between stat calls.
 */
export class StateCacheManager {
  private learningDbMtimeMs = 0;
  private readonly stateDir: string;
  private readonly cacheKeyPrefix: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly logger: Logger;

  /**
   * Create a state cache manager.
   * @param cacheKeyPrefix - Prefix used when building cache keys.
   * @param options - Optional state directory, repo, and branch overrides.
   */
  constructor(cacheKeyPrefix: string, options: StateCacheManagerOptions = {}) {
    this.cacheKeyPrefix = cacheKeyPrefix;
    this.stateDir = options.stateDir ?? path.resolve(process.cwd(), '.opencode');
    this.repo = options.repo ?? `${github.context.repo.owner}/${github.context.repo.repo}`;
    this.branch = options.branch ?? github.context.ref.replace('refs/heads/', '');
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

  /**
   * Restore the learning state from the Actions cache.
   * Skips restore when the `.opencode` directory already exists.
   */
  async restore(): Promise<void> {
    if (fs.existsSync(this.stateDir)) {
      core.info('.opencode/ directory already exists — skipping cache restore');
      this.learningDbMtimeMs = this.getLearningDbMtime();
      return;
    }

    core.info('Restoring learning state from cache...');
    const primaryKey = buildCacheKey(this.cacheKeyPrefix, this.repo, this.branch);
    const restoreKeys = [`${this.cacheKeyPrefix}-${this.repo}-`];
    try {
      const cacheKey = await restoreCache([this.stateDir], primaryKey, restoreKeys);
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
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.learningDbMtimeMs = this.getLearningDbMtime();
  }

  /**
   * Save the learning state to the Actions cache when it has changed.
   * Skips save when the state directory or `learning.db` is missing, or when
   * the on-disk mtime is unchanged since the last restore.
   */
  async save(): Promise<void> {
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
    if (currentMtime > 0 && Math.abs(currentMtime - this.learningDbMtimeMs) < 1) {
      core.info('Learning state unchanged — skipping cache save');
      return;
    }

    const cacheKey = buildCacheKey(this.cacheKeyPrefix, this.repo, this.branch);
    try {
      await saveCache([this.stateDir], cacheKey);
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
