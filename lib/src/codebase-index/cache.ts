import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger.js';
import type { CodebaseIndexData } from './types.js';

/**
 * Ref-keyed JSON cache for codebase indexes.
 *
 * Indexes are keyed by the full git ref SHA so they are invalidated
 * automatically whenever the reviewed ref changes (the acceptance-criteria
 * invalidation model). Writes are performed via a temp file + atomic rename so
 * concurrent action runs never observe a partially-written index.
 */
export class CodebaseIndexCache {
  private readonly logger = new Logger('CodebaseIndexCache');

  /**
   * @param cacheDir - Directory where `<sha>.json` cache files are stored.
   */
  constructor(private readonly cacheDir: string) {}

  /**
   * Load a cached index for a ref SHA.
   * @param refSha - Full git ref SHA used as the cache key.
   * @returns The cached index, or null when absent, corrupt, or mismatched.
   */
  get(refSha: string): CodebaseIndexData | null {
    if (!refSha) return null;
    try {
      const raw = fs.readFileSync(this.cachePath(refSha), 'utf-8');
      const data = JSON.parse(raw) as CodebaseIndexData;
      if (data.refSha !== refSha) return null;
      if (
        !Array.isArray(data.symbols) ||
        !Array.isArray(data.imports) ||
        !Array.isArray(data.callGraph)
      ) {
        return null;
      }
      return data;
    } catch (err) {
      this.logger.debug(
        `Failed to read codebase index cache for ${refSha}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Persist an index for a ref SHA (atomic write via temp file + rename).
   * @param refSha - Full git ref SHA used as the cache key.
   * @param data - The codebase index to persist.
   */
  set(refSha: string, data: CodebaseIndexData): void {
    if (!refSha) return;
    let tmp: string | undefined;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const file = this.cachePath(refSha);
      tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
      fs.renameSync(tmp, file);
      tmp = undefined;
    } catch (err) {
      // Caching is best-effort — a failed write must never break the review.
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // Best-effort cleanup of the partial temp file.
        }
      }
      this.logger.debug(
        `Failed to persist codebase index cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Remove a cached index for a ref SHA.
   * @param refSha - Full git ref SHA whose cache entry should be removed.
   */
  invalidate(refSha: string): void {
    if (!refSha) return;
    try {
      fs.unlinkSync(this.cachePath(refSha));
    } catch (err) {
      this.logger.debug(
        `Failed to invalidate codebase index cache for ${refSha}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private cachePath(refSha: string): string {
    return path.join(this.cacheDir, `${refSha}.json`);
  }
}
