export declare function buildCacheKey(prefix: string, repo?: string, branch?: string): string;
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
    constructor(cacheKeyPrefix: string, options?: StateCacheManagerOptions);
    private getLearningDbMtime;
    restore(): Promise<void>;
    save(): Promise<void>;
}
