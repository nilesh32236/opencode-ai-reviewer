/**
 * Build a cache key for the learning state.
 * @param prefix - Cache key prefix.
 * @param repo - Repository in `owner/name` form. Defaults to the GitHub Actions context.
 * @param branch - Branch ref. Defaults to the GitHub Actions context.
 * @returns The assembled cache key.
 */
export declare function buildCacheKey(prefix: string, repo?: string, branch?: string): string;
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
export declare class StateCacheManager {
    private learningDbMtimeMs;
    private readonly stateDir;
    private readonly cacheKeyPrefix;
    private readonly repo;
    private readonly branch;
    private readonly logger;
    /**
     * Create a state cache manager.
     * @param cacheKeyPrefix - Prefix used when building cache keys.
     * @param options - Optional state directory, repo, and branch overrides.
     */
    constructor(cacheKeyPrefix: string, options?: StateCacheManagerOptions);
    private getLearningDbMtime;
    /**
     * Restore the learning state from the Actions cache.
     * Skips restore when the `.opencode` directory already exists.
     */
    restore(): Promise<void>;
    /**
     * Save the learning state to the Actions cache when it has changed.
     * Skips save when the state directory or `learning.db` is missing, or when
     * the on-disk mtime is unchanged since the last restore.
     */
    save(): Promise<void>;
}
