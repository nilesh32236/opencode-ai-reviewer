import * as path from 'path';
import type { CodebaseIndexCache } from './cache.js';
import { CodebaseExtractor } from './extractor.js';
import type {
  CallGraphEdge,
  CodebaseContext,
  CodebaseIndexData,
  ImportEdge,
  IndexedSymbol,
} from './types.js';

export { CodebaseIndexCache } from './cache.js';
export { CodebaseExtractor } from './extractor.js';
export type {
  CodebaseContext,
  CodebaseIndexData,
  CallGraphEdge,
  ImportEdge,
  IndexedSymbol,
} from './types.js';

/** Formatting caps that keep the injected context bounded in the prompt. */
const MAX_SYMBOLS_PER_SECTION = 100;
const MAX_EDGES_PER_SECTION = 150;

/**
 * Orchestrates codebase indexing: extraction + ref-keyed caching + prompt
 * enrichment for a set of changed files.
 *
 * The index is built once per ref and cached (by default outside the git
 * checkout, under the OS temp dir keyed by repository identity) so repeated
 * reviews on the same ref skip recomputation. Cross-file context
 * (exported symbols, import edges, call-graph edges) is filtered down to only
 * what is relevant to the changed files and formatted as markdown for the
 * review prompt.
 */
export class CodebaseIndex {
  private readonly extractor: CodebaseExtractor;
  private rootDir: string | null = null;

  /**
   * @param cache - Optional ref-keyed cache for skipping rebuilds on the same ref.
   */
  constructor(private readonly cache?: CodebaseIndexCache) {
    this.extractor = new CodebaseExtractor();
  }

  /**
   * Build a codebase index for a ref, or load it from the cache when a cached
   * index for the same `refSha` already exists. Stores the resolved root so
   * `getContextForFiles` can normalize absolute changed file paths.
   *
   * @param rootDir - Repository (or package) root to index.
   * @param refSha - Full git ref SHA used as the cache key.
   * @returns The codebase index stamped with `refSha`.
   */
  async buildOrLoad(rootDir: string, refSha: string): Promise<CodebaseIndexData> {
    const resolvedRoot = path.resolve(rootDir);
    this.rootDir = resolvedRoot;
    const cached = this.cache?.get(refSha);
    if (cached) return cached;
    const data = this.extractor.extract(resolvedRoot);
    const stamped: CodebaseIndexData = { ...data, refSha };
    this.cache?.set(refSha, stamped);
    return stamped;
  }

  /**
   * Filter a codebase index down to the cross-file context relevant to a set
   * of changed files.
   *
   * @param index - The full codebase index.
   * @param changedFiles - Changed file paths (relative or absolute).
   * @returns The relevant cross-file context.
   */
  getContextForFiles(index: CodebaseIndexData, changedFiles: string[]): CodebaseContext {
    const normalizedCache = new Map<string, string>();
    const normalize = (file: string): string => {
      let value = normalizedCache.get(file);
      if (value === undefined) {
        value = this.normalizeChangedFile(file);
        normalizedCache.set(file, value);
      }
      return value;
    };
    const changedSet = new Set(changedFiles.map((file) => normalize(file)));
    const isChanged = (file: string): boolean => changedSet.has(normalize(file));

    const localSymbols: IndexedSymbol[] = [];
    const exportedSymbols: IndexedSymbol[] = [];
    for (const symbol of index.symbols) {
      if (isChanged(symbol.file)) {
        localSymbols.push(symbol);
        if (symbol.isExported) exportedSymbols.push(symbol);
      }
    }

    const affectedImports: ImportEdge[] = [];
    for (const edge of index.imports) {
      if (isChanged(edge.sourceFile) || (edge.targetFile && isChanged(edge.targetFile))) {
        affectedImports.push(edge);
      }
    }

    const affectedCallers: CallGraphEdge[] = [];
    const affectedCallees: CallGraphEdge[] = [];
    for (const edge of index.callGraph) {
      if (isChanged(edge.calleeFile)) {
        affectedCallers.push(edge);
      } else if (isChanged(edge.callerFile)) {
        affectedCallees.push(edge);
      }
    }

    return { localSymbols, exportedSymbols, affectedImports, affectedCallers, affectedCallees };
  }

  /**
   * Format cross-file context as markdown for prompt injection.
   *
   * @param context - The relevant cross-file context.
   * @returns The formatted markdown, or '' when there is nothing relevant.
   */
  formatContext(context: CodebaseContext): string {
    const parts: string[] = [];
    const empty =
      context.localSymbols.length === 0 &&
      context.exportedSymbols.length === 0 &&
      context.affectedImports.length === 0 &&
      context.affectedCallers.length === 0 &&
      context.affectedCallees.length === 0;
    if (empty) return '';

    if (context.exportedSymbols.length > 0) {
      parts.push('### Exported Symbols in Changed Files');
      for (const symbol of context.exportedSymbols.slice(0, MAX_SYMBOLS_PER_SECTION)) {
        parts.push(this.formatSymbol(symbol));
      }
      this.pushTruncationNotice(parts, context.exportedSymbols.length, MAX_SYMBOLS_PER_SECTION);
      parts.push('');
    }

    if (context.localSymbols.length > 0) {
      parts.push('### Symbols Defined in Changed Files');
      for (const symbol of context.localSymbols.slice(0, MAX_SYMBOLS_PER_SECTION)) {
        parts.push(this.formatSymbol(symbol));
      }
      this.pushTruncationNotice(parts, context.localSymbols.length, MAX_SYMBOLS_PER_SECTION);
      parts.push('');
    }

    if (context.affectedImports.length > 0) {
      // External/bare specifiers (node builtins, npm packages) are not "broken
      // local imports" — only genuinely local relative specifiers that failed
      // to resolve are reported as potentially broken.
      const unresolved = context.affectedImports.filter(
        (edge) => !edge.targetFile && !edge.isExternal,
      );
      if (unresolved.length > 0) {
        parts.push('### Unresolved Local Imports (possible broken imports)');
        for (const edge of unresolved.slice(0, MAX_EDGES_PER_SECTION)) {
          const symbol = edge.importedSymbol ? `\`${edge.importedSymbol}\`` : '(side-effect)';
          parts.push(
            `- ${edge.sourceFile}:${edge.line} imports ${symbol} from an unresolvable local module`,
          );
        }
        this.pushTruncationNotice(parts, unresolved.length, MAX_EDGES_PER_SECTION);
        parts.push('');
      }
      const resolved = context.affectedImports.filter((edge) => edge.targetFile);
      if (resolved.length > 0) {
        parts.push('### Import Relationships');
        for (const edge of resolved.slice(0, MAX_EDGES_PER_SECTION)) {
          const symbol = edge.importedSymbol ? `\`${edge.importedSymbol}\`` : '(side-effect)';
          parts.push(
            `- ${edge.sourceFile}:${edge.line} imports ${symbol} from \`${edge.targetFile}\``,
          );
        }
        this.pushTruncationNotice(parts, resolved.length, MAX_EDGES_PER_SECTION);
        parts.push('');
      }
    }

    if (context.affectedCallers.length > 0) {
      parts.push('### Callers of Changed Files');
      for (const edge of context.affectedCallers.slice(0, MAX_EDGES_PER_SECTION)) {
        parts.push(
          `- \`${edge.callerFile}:${edge.line}\` — \`${edge.callerFunction}()\` → \`${edge.calleeFunction}()\` in \`${edge.calleeFile}\``,
        );
      }
      this.pushTruncationNotice(parts, context.affectedCallers.length, MAX_EDGES_PER_SECTION);
      parts.push('');
    }

    if (context.affectedCallees.length > 0) {
      parts.push('### Callees Called by Changed Files');
      for (const edge of context.affectedCallees.slice(0, MAX_EDGES_PER_SECTION)) {
        parts.push(
          `- \`${edge.callerFile}:${edge.line}\` — \`${edge.callerFunction}()\` → \`${edge.calleeFunction}()\` in \`${edge.calleeFile}\``,
        );
      }
      this.pushTruncationNotice(parts, context.affectedCallees.length, MAX_EDGES_PER_SECTION);
      parts.push('');
    }

    return parts.join('\n').replace(/\n+$/, '');
  }

  private pushTruncationNotice(parts: string[], total: number, cap: number): void {
    if (total > cap) parts.push(`- ... and ${total - cap} more (list truncated)`);
  }

  private formatSymbol(symbol: IndexedSymbol): string {
    const signature = symbol.signature ? ` ${symbol.signature}` : '';
    const flags = [
      symbol.isDefaultExport ? 'default export' : '',
      symbol.isExported && !symbol.isDefaultExport ? 'exported' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `- \`${symbol.name}\`${signature} — ${symbol.file}:${symbol.line} (${symbol.kind}${flags ? `, ${flags}` : ''})`;
  }

  private normalizeChangedFile(file: string): string {
    if (this.rootDir && path.isAbsolute(file)) {
      const relative = path.relative(this.rootDir, file);
      return relative.split(path.sep).join('/');
    }
    return file.replace(/\\/g, '/');
  }
}
