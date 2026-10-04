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
export declare function sanitizeBranchForCacheKey(branch: string): string;
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
 * @returns The composite cache key string.
 */
export declare function buildCacheKey(prefix: string, repo?: string, branch?: string, sha?: string): string;
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
export declare function deriveJsonStatePath(dbPath: string): string;
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
export declare class StateCacheManager {
    private learningDbMtimeMs;
    private readonly stateDir;
    private readonly cacheKeyPrefix;
    private readonly repo;
    private readonly branch;
    private readonly sha;
    private readonly logger;
    private savePromise;
    /**
     * Content hash of the last successfully saved snapshot. Skipping saves
     * when the hash is unchanged bounds Actions-cache growth (GitHub caps the
     * cache at 10 GB and each unique `${baseKey}-${hash}` key is an additional
     * entry): repeated runs with identical db content reuse the existing entry
     * instead of minting a duplicate snapshot key.
     */
    private lastSavedContentHash;
    private readonly circuitBreaker;
    /**
     * Create a state cache manager.
     *
     * @param cacheKeyPrefix - Prefix used for both restore and save cache keys.
     * @param options - Optional stateDir, repo, and branch overrides.
     */
    constructor(cacheKeyPrefix: string, options?: StateCacheManagerOptions);
    private getStateFileMtime;
    /**
     * Stable, branch-scoped restore key: `<prefix>-<schema>-<repo>-<branch>`.
     *
     * Deliberately EXCLUDES the commit SHA. The SHA used to be part of this
     * key, which made the feature structurally unable to restore: every new
     * commit minted a key nothing had ever saved under, and `restoreKeys` had
     * no looser prefix to fall back to, so learning state (dismissals, feedback
     * signals, suppression rules, telemetry) was re-created from scratch on
     * every run while `save()` grew the cache with unreadable entries toward
     * the 10 GB repository cap.
     *
     * Cross-ref poisoning stays impossible because the repo AND the sanitized
     * branch slug are both part of the key — a different ref gets a different
     * key, never a fallback to this one. Legacy (pre-version) entries are
     * excluded by the `v2` segment, so a stale-format snapshot can never be
     * restored into a run expecting the current format.
     *
     * @returns The branch-scoped restore key.
     */
    private buildRestoreKey;
    /**
     * Snapshot key for `save()`: the branch-scoped restore key plus the commit
     * SHA, so each commit keeps its own immutable snapshot entry. The SHA is
     * HEX-only and cannot inject key structure or collide across refs, and it is
     * stripped when absent (direct library callers without a SHA).
     *
     * @returns The per-commit snapshot key.
     */
    private buildSnapshotKey;
    /**
     * Mtime of whichever backend file currently exists on disk (db preferred
     * when both are present), without validation or quarantine. Used to capture
     * the post-restore baseline exactly like the legacy db-only path did.
     *
     * @returns Mtime in milliseconds of the active state file, or 0 when neither backend file exists.
     */
    private getCurrentStateMtime;
    /**
     * Hash the active state file content without loading the whole file into memory.
     * Streams the file through SHA-256 so a large DB does not spike heap on
     * every save. Only called after the mtime fast-path already detected a
     * change, so hashing runs solely when the state was actually modified.
     * @param statePath - Absolute path to the active state file to hash.
     * @returns Hex SHA-256 of the file content (empty string on read failure).
     */
    private hashStateFileContent;
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
     * @returns The active backend file, or null when no usable state exists.
     */
    private resolveActiveStateFile;
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
    restore(): Promise<void>;
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
    save(): Promise<void>;
    private saveState;
}
