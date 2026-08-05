/**
 * Build a primary cache key for restore. Combines the prefix with the
 * repository NWO and branch ref so state cached for one branch is never
 * restored onto another. Falls back to the GitHub Actions context when the
 * repo or branch is not provided explicitly.
 *
 * @param prefix - Cache key prefix (e.g. `learning-state`).
 * @param repo - Repository in `owner/name` format; defaults to the GitHub context.
 * @param branch - Branch ref; defaults to the GitHub context ref without `refs/heads/`.
 * @returns The composite cache key string.
 */
export declare function buildCacheKey(prefix: string, repo?: string, branch?: string): string;
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
export declare class StateCacheManager {
    private learningDbMtimeMs;
    /** Cache key returned by the most recent successful restore (undefined when nothing was restored). */
    private restoredCacheKey;
    private readonly stateDir;
    private readonly cacheKeyPrefix;
    private readonly repo;
    private readonly branch;
    private readonly logger;
    private readonly circuitBreaker;
    /**
     * Create a state cache manager.
     *
     * @param cacheKeyPrefix - Prefix used for both restore and save cache keys.
     * @param options - Optional stateDir, repo, and branch overrides.
     */
    constructor(cacheKeyPrefix: string, options?: StateCacheManagerOptions);
    private getLearningDbMtime;
    private hashLearningDbContent;
    /**
     * Restore the learning state from the Actions cache into `stateDir`.
     * Skips when the state directory already exists (it already holds a fresh
     * database for this run). Records the resolved cache key so `save()` can
     * derive a unique snapshot key instead of overwriting the restore key.
     *
     * @returns A promise that resolves when the restore attempt completes.
     */
    restore(): Promise<void>;
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
    save(): Promise<void>;
}
