import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger.js';
import type { CallGraphEdge, CodebaseIndexData, ImportEdge, IndexedSymbol } from './types.js';

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
      if (!this.isValidIndex(data)) return null;
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

  /**
   * Validate the shape of a cached index. Beyond the collection-level array
   * check, every entry must carry its required fields so a schema-drifted,
   * hand-edited, or attacker-supplied cache file degrades to a rebuild instead
   * of rendering garbage (e.g. `undefined` values) into the review prompt.
   * @param data - The parsed cache entry.
   * @returns True when the entry is structurally valid.
   */
  private isValidIndex(data: CodebaseIndexData): boolean {
    if (
      !Array.isArray(data.symbols) ||
      !Array.isArray(data.imports) ||
      !Array.isArray(data.callGraph)
    ) {
      return false;
    }
    const validSymbol = (s: IndexedSymbol): boolean =>
      typeof s === 'object' &&
      s !== null &&
      typeof s.name === 'string' &&
      typeof s.file === 'string' &&
      typeof s.line === 'number' &&
      typeof s.column === 'number' &&
      typeof s.kind === 'string' &&
      typeof s.isDefaultExport === 'boolean' &&
      typeof s.isExported === 'boolean';
    const validImport = (e: ImportEdge): boolean =>
      typeof e === 'object' &&
      e !== null &&
      typeof e.sourceFile === 'string' &&
      typeof e.importedSymbol === 'string' &&
      typeof e.targetFile === 'string' &&
      typeof e.importKind === 'string' &&
      typeof e.line === 'number';
    const validCall = (e: CallGraphEdge): boolean =>
      typeof e === 'object' &&
      e !== null &&
      typeof e.callerFile === 'string' &&
      typeof e.callerFunction === 'string' &&
      typeof e.calleeFile === 'string' &&
      typeof e.calleeFunction === 'string' &&
      typeof e.line === 'number';
    return (
      data.symbols.every(validSymbol) &&
      data.imports.every(validImport) &&
      data.callGraph.every(validCall)
    );
  }
}
