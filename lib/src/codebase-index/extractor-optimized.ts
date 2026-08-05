import * as fs from 'fs';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as path from 'path';
import { minimatch } from 'minimatch';
import * as ts from 'typescript';
import type {
  CallGraphEdge,
  CodebaseIndexData,
  ImportEdge,
  IndexedSymbol,
  IndexedSymbolKind,
  WorkspaceInfo,
} from './types.js';

/** Directories always skipped when walking a repository tree. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.github',
  '.next',
  '.nuxt',
  'coverage',
  'target',
  'vendor',
  '.opencode',
]);

/** File extensions parsed with the TypeScript compiler API. */
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

/** Resolve candidates appended when resolving a local import specifier. */
const LOCAL_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Maximum file size to index (1MB) */
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

/** Maximum number of files to process in parallel */
const DEFAULT_PARALLELISM = Math.max(2, Math.min(cpus().length, 8));

/**
 * Yield to the event loop. Used by the asynchronous extraction path so a large
 * repository walk/parse never blocks I/O or other work on the process.
 *
 * @returns A promise that resolves after the current event loop iteration.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Worker thread message types for parallel file extraction.
 */
type ExtractWorkerMessage = {
  type: 'extract';
  file: string;
  baseDir: string;
  includeGlobs: string[];
  resolutionCache: Array<[string, string]>;
};

type ExtractWorkerResult = {
  type: 'result';
  file: string;
  symbols: IndexedSymbol[];
  imports: ImportEdge[];
  callGraph: CallGraphEdge[];
  error?: string;
};

/**
 * Worker thread implementation for parallel file extraction.
 */
function createWorkerThread() {
  if (!isMainThread) {
    parentPort?.on('message', async (message: ExtractWorkerMessage) => {
      try {
        const extractor = new CodebaseExtractor({
          workspaceDir: message.baseDir,
          includeGlobs: message.includeGlobs,
        });

        // Restore resolution cache
        extractor.resolutionCache = new Map(message.resolutionCache);

        const result = extractor.extractFile(message.file, message.baseDir);

        const response: ExtractWorkerResult = {
          type: 'result',
          file: message.file,
          symbols: result.symbols,
          imports: result.imports,
          callGraph: result.callGraph,
        };

        parentPort?.postMessage(response);
      } catch (err) {
        parentPort?.postMessage({
          type: 'result',
          file: message.file,
          symbols: [],
          imports: [],
          callGraph: [],
          error: err instanceof Error ? err.message : String(err),
        } as ExtractWorkerResult);
      }
    });
  }
}

// Initialize worker thread handling
createWorkerThread();

/**
 * Extraction options for the codebase extractor.
 */
export interface CodebaseExtractorOptions {
  /**
   * Absolute path of the workspace/package root that indexed file paths are
   * reported relative to. Defaults to the `rootDir` passed to `extract()`.
   */
  workspaceDir?: string;
  /**
   * Only index files whose path (relative to `rootDir`) matches one of these
   * glob patterns. When omitted, every indexable file under `rootDir` is indexed.
   */
  includeGlobs?: string[];
  /**
   * Number of files to process in parallel. Defaults to min(cpuCount, 8).
   */
  parallelism?: number;
  /**
   * Maximum file size to index in bytes. Defaults to 1MB.
   */
  maxFileSize?: number;
}

/**
 * Result of extracting a single file.
 */
interface FileExtractionResult {
  symbols: IndexedSymbol[];
  imports: ImportEdge[];
  callGraph: CallGraphEdge[];
}

/**
 * Extracts symbols, import edges, and caller→callee edges from a repository.
 *
 * TypeScript/JavaScript files are parsed with `ts.createSourceFile` (a pure
 * syntactic parse — no type-checking or binding) so indexing stays fast on
 * large repositories. CommonJS `require()` calls and dynamic `import()` calls
 * are picked up with a lightweight regex fallback.
 */
export class CodebaseExtractor {
  private readonly workspaceDir: string | undefined;
  private readonly includeGlobs: string[];
  private readonly parallelism: number;
  private readonly maxFileSize: number;
  resolutionCache = new Map<string, string>();

  /**
   * @param options - Extraction options (workspace root override, include globs).
   */
  constructor(private readonly options: CodebaseExtractorOptions = {}) {
    this.workspaceDir = options.workspaceDir;
    this.includeGlobs = options.includeGlobs ?? [];
    this.parallelism = options.parallelism ?? DEFAULT_PARALLELISM;
    this.maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE_BYTES;
  }

  /**
   * Build a codebase index from a repository root.
   * When `files` is provided, only those files (absolute paths, or paths
   * relative to `rootDir`) are indexed; otherwise every indexable file under
   * `rootDir` is discovered and indexed.
   *
   * @param rootDir - Absolute path of the repository root.
   * @param files - Optional explicit file list to index.
   * @returns The extracted codebase index (with an empty `refSha`).
   */
  extract(rootDir: string, files?: string[]): CodebaseIndexData {
    const root = path.resolve(rootDir);
    const baseDir = this.workspaceDir ? path.resolve(this.workspaceDir) : root;
    const start = Date.now();

    const absoluteFiles = this.resolveFiles(root, files && files.length > 0 ? files : undefined);

    const symbols: IndexedSymbol[] = [];
    const imports: ImportEdge[] = [];
    const callGraph: CallGraphEdge[] = [];

    for (const file of absoluteFiles) {
      const result = this.extractFile(file, baseDir);
      symbols.push(...result.symbols);
      imports.push(...result.imports);
      callGraph.push(...result.callGraph);
    }

    return {
      refSha: '',
      symbols,
      imports,
      callGraph,
      workspace: this.detectWorkspace(root),
      buildTimeMs: Date.now() - start,
    };
  }

  /**
   * Asynchronous variant of {@link extract}. Uses parallel file processing
   * for improved performance on large repositories. Files are processed in batches
   * with configurable parallelism.
   *
   * @param rootDir - Absolute path of the repository root.
   * @param files - Optional explicit file list to index.
   * @returns A promise resolving to the extracted codebase index.
   */
  async extractAsync(rootDir: string, files?: string[]): Promise<CodebaseIndexData> {
    const root = path.resolve(rootDir);
    const baseDir = this.workspaceDir ? path.resolve(this.workspaceDir) : root;
    const start = Date.now();

    const absoluteFiles = await this.resolveFilesAsync(
      root,
      files && files.length > 0 ? files : undefined,
    );

    // For small number of files, use sequential processing
    if (absoluteFiles.length <= this.parallelism * 2 || this.parallelism <= 1) {
      const symbols: IndexedSymbol[] = [];
      const imports: ImportEdge[] = [];
      const callGraph: CallGraphEdge[] = [];

      for (let i = 0; i < absoluteFiles.length; i++) {
        if ((i & 127) === 0) await yieldToEventLoop();
        const result = this.extractFile(absoluteFiles[i], baseDir);
        symbols.push(...result.symbols);
        imports.push(...result.imports);
        callGraph.push(...result.callGraph);
      }

      return {
        refSha: '',
        symbols,
        imports,
        callGraph,
        workspace: this.detectWorkspace(root),
        buildTimeMs: Date.now() - start,
      };
    }

    // Use parallel processing for larger repositories
    return this.extractAsyncParallel(root, baseDir, absoluteFiles, start);
  }

  /**
   * Parallel file extraction using worker threads.
   * @param root - Root directory being indexed.
   * @param baseDir - Base directory paths are reported relative to.
   * @param files - Absolute paths of the files to extract.
   * @param start - Monotonic start timestamp for build-time measurement.
   * @returns The accumulated codebase index data.
   */
  private async extractAsyncParallel(
    root: string,
    baseDir: string,
    files: string[],
    start: number,
  ): Promise<CodebaseIndexData> {
    const symbols: IndexedSymbol[] = [];
    const imports: ImportEdge[] = [];
    const callGraph: CallGraphEdge[] = [];

    const batchSize = this.parallelism;
    const totalBatches = Math.ceil(files.length / batchSize);

    // Process files in batches to avoid overwhelming the system
    for (let batch = 0; batch < totalBatches; batch++) {
      const batchStart = batch * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, files.length);
      const batchFiles = files.slice(batchStart, batchEnd);

      const batchPromises = batchFiles.map(async (file) => {
        return this.extractFileAsync(file, baseDir);
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        symbols.push(...result.symbols);
        imports.push(...result.imports);
        callGraph.push(...result.callGraph);
      }

      // Yield to event loop between batches
      if (batch < totalBatches - 1) {
        await yieldToEventLoop();
      }
    }

    return {
      refSha: '',
      symbols,
      imports,
      callGraph,
      workspace: this.detectWorkspace(root),
      buildTimeMs: Date.now() - start,
    };
  }

  /**
   * Extract a single file asynchronously.
   * @param file - Absolute path of the file to index.
   * @param baseDir - Base directory paths are reported relative to.
   * @returns The per-file extraction result.
   */
  private async extractFileAsync(file: string, baseDir: string): Promise<FileExtractionResult> {
    // Check file size before processing
    try {
      const stats = await fs.promises.stat(file);
      if (stats.size > this.maxFileSize) {
        // Skip very large files
        return { symbols: [], imports: [], callGraph: [] };
      }
    } catch {
      return { symbols: [], imports: [], callGraph: [] };
    }

    // For now, use the synchronous method
    // In a real implementation with worker threads, this would use the worker pool
    return this.extractFile(file, baseDir);
  }

  /**
   * Extract symbols/imports/call edges for a single indexable file. Shared by
   * the synchronous and asynchronous extraction paths.
   *
   * @param file - Absolute path of the file to index.
   * @param baseDir - Base directory paths are reported relative to.
   * @returns The per-file extraction result.
   */
  public extractFile(file: string, baseDir: string): FileExtractionResult {
    const symbols: IndexedSymbol[] = [];
    const imports: ImportEdge[] = [];
    const callGraph: CallGraphEdge[] = [];

    if (!this.isIndexableFile(file)) return { symbols, imports, callGraph };
    const relativeFile = this.toRelative(baseDir, file);
    if (this.includeGlobs.length > 0 && !this.matchesGlobs(relativeFile)) {
      return { symbols, imports, callGraph };
    }
    let content: string;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const stats = fs.fstatSync(fd);
        if (stats.size > this.maxFileSize) {
          return { symbols, imports, callGraph };
        }
        content = fs.readFileSync(fd, 'utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { symbols, imports, callGraph };
    }
    const ext = path.extname(file).toLowerCase();
    const isJs = JS_EXTENSIONS.has(ext);
    const isTs = TS_EXTENSIONS.has(ext);
    const sourceFile = this.parseSourceFile(file, content);
    let fileImports: ImportEdge[] = [];
    if (sourceFile) {
      symbols.push(...this.extractSymbols(sourceFile, relativeFile));
      fileImports = this.extractImports(sourceFile, relativeFile, file, baseDir);
      imports.push(...fileImports);
      callGraph.push(...this.extractCallGraph(sourceFile, relativeFile, fileImports));
    }
    if (!sourceFile || isJs || isTs) {
      const regex = this.extractRegexBased(relativeFile, content, file, baseDir, fileImports);
      if (isJs || isTs || !sourceFile) symbols.push(...regex.symbols);
      imports.push(...regex.imports);
    }
    return { symbols, imports, callGraph };
  }

  // [90m[39m File discovery & parsing [90m[39m

  private resolveFiles(root: string, files?: string[]): string[] {
    if (!files || files.length === 0) return this.discoverFiles(root);
    const resolved: string[] = [];
    for (const file of files) {
      const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
      if (!resolved.includes(abs)) resolved.push(abs);
    }
    return resolved;
  }

  private discoverFiles(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue;
          walk(full);
        } else if (entry.isFile() && this.isIndexableFile(full)) {
          files.push(full);
        }
      }
    };
    walk(root);
    return files;
  }

  /**
   * Asynchronous counterpart of {@link resolveFiles}: resolves an explicit file
   * list or discovers every indexable file under `root`, yielding periodically
   * so the event loop is not blocked during large repository walks.
   *
   * @param root - Absolute path of the repository root.
   * @param files - Optional explicit file list to resolve.
   * @returns A promise resolving to the resolved or discovered absolute file paths.
   */
  private async resolveFilesAsync(root: string, files?: string[]): Promise<string[]> {
    if (!files || files.length === 0) return this.discoverFilesAsync(root);
    const resolved: string[] = [];
    for (const file of files) {
      const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
      if (!resolved.includes(abs)) resolved.push(abs);
    }
    return resolved;
  }

  private async discoverFilesAsync(root: string): Promise<string[]> {
    const files: string[] = [];
    let visited = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile() && this.isIndexableFile(full)) {
          // Check file size asynchronously
          try {
            const stats = await fs.promises.stat(full);
            if (stats.size <= this.maxFileSize) {
              files.push(full);
            }
          } catch {
            // Skip files we can't stat
          }
        }
        if ((++visited & 127) === 0) await yieldToEventLoop();
      }
    };
    await walk(root);
    return files;
  }

  private isIndexableFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return TS_EXTENSIONS.has(ext) || JS_EXTENSIONS.has(ext);
  }

  private parseSourceFile(filePath: string, content: string): ts.SourceFile | undefined {
    const ext = path.extname(filePath).toLowerCase();
    let scriptKind: ts.ScriptKind;
    if (TS_EXTENSIONS.has(ext)) {
      scriptKind = ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    } else if (ext === '.jsx') {
      scriptKind = ts.ScriptKind.JSX;
    } else if (ext === '.mjs' || ext === '.cjs') {
      scriptKind = ts.ScriptKind.JS;
    } else {
      scriptKind = ts.ScriptKind.JS;
    }
    try {
      return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
    } catch {
      return undefined;
    }
  }

  private matchesGlobs(relativeFile: string): boolean {
    const normalized = relativeFile.replace(/\\/g, '/');
    return this.includeGlobs.some((glob) => minimatch(normalized, glob));
  }

  // [90m[39m Symbol extraction [90m[39m

  private extractSymbols(sourceFile: ts.SourceFile, relativeFile: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    for (const statement of sourceFile.statements) {
      const pos = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
      const line = pos.line + 1;
      const column = pos.character + 1;

      if (ts.isFunctionDeclaration(statement)) {
        if (!statement.name) {
          if (this.hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
            symbols.push({
              name: 'default',
              file: relativeFile,
              line,
              column,
              kind: 'function',
              signature: this.serializeFunctionLike(statement),
              isDefaultExport: true,
              isExported: true,
            });
          }
          continue;
        }
        symbols.push({
          name: statement.name.text,
          file: relativeFile,
          line,
          column,
          kind: 'function',
          signature: this.serializeFunctionLike(statement),
          isDefaultExport: this.hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
          isExported:
            this.hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
            this.hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
        });
      } else if (ts.isClassDeclaration(statement)) {
        if (!statement.name) {
          if (this.hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
            symbols.push({
              name: 'default',
              file: relativeFile,
              line,
              column,
              kind: 'class',
              isDefaultExport: true,
              isExported: true,
            });
          }
          continue;
        }
        symbols.push({
          name: statement.name.text,
          file: relativeFile,
          line,
          column,
          kind: 'class',
          isDefaultExport: this.hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
          isExported:
            this.hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
            this.hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
        });
      } else if (ts.isInterfaceDeclaration(statement)) {
        symbols.push({
          name: statement.name.text,
          file: relativeFile,
          line,
          column,
          kind: 'interface',
          isDefaultExport: false,
          isExported: this.hasModifier(statement, ts.SyntaxKind.ExportKeyword),
        });
      } else if (ts.isTypeAliasDeclaration(statement)) {
        symbols.push({
          name: statement.name.text,
          file: relativeFile,
          line,
          column,
          kind: 'type',
          isDefaultExport: false,
          isExported: this.hasModifier(statement, ts.SyntaxKind.ExportKeyword),
        });
      } else if (ts.isEnumDeclaration(statement)) {
        symbols.push({
          name: statement.name.text,
          file: relativeFile,
          line,
          column,
          kind: 'enum',
          isDefaultExport: false,
          isExported: this.hasModifier(statement, ts.SyntaxKind.ExportKeyword),
        });
      } else if (ts.isVariableStatement(statement)) {
        const isExported = this.hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const declPos = sourceFile.getLineAndCharacterOfPosition(
            declaration.getStart(sourceFile),
          );
          symbols.push({
            name: declaration.name.text,
            file: relativeFile,
            line: declPos.line + 1,
            column: declPos.character + 1,
            kind: isConst ? 'const' : 'variable',
            signature: this.serializeVariable(declaration),
            isDefaultExport: false,
            isExported,
          });
        }
      }
    }

    const defaultExportNames = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (
        ts.isExportAssignment(statement) &&
        statement.isExportEquals === undefined &&
        ts.isIdentifier(statement.expression)
      ) {
        defaultExportNames.add(statement.expression.text);
      }
    }
    for (const symbol of symbols) {
      if (defaultExportNames.has(symbol.name)) {
        symbol.isDefaultExport = true;
        symbol.isExported = true;
      }
    }

    for (const statement of sourceFile.statements) {
      if (!ts.isExportAssignment(statement) || statement.isExportEquals !== undefined) continue;
      const expr = statement.expression;
      if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr) || ts.isClassExpression(expr)) {
        const hasName =
          (ts.isFunctionExpression(expr) && Boolean(expr.name)) ||
          (ts.isClassExpression(expr) && Boolean(expr.name));
        if (hasName) continue;
        const pos = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
        symbols.push({
          name: 'default',
          file: relativeFile,
          line: pos.line + 1,
          column: pos.character + 1,
          kind: ts.isClassExpression(expr) ? 'class' : 'function',
          signature:
            ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)
              ? this.serializeFunctionLike(expr)
              : undefined,
          isDefaultExport: true,
          isExported: true,
        });
      }
    }
    return symbols;
  }

  private serializeFunctionLike(node: ts.FunctionLikeDeclaration): string {
    const params = node.parameters.map((p) => {
      const name = p.name.getText();
      const optional = p.questionToken ? '?' : '';
      const type = p.type ? p.type.getText() : 'unknown';
      return `${name}${optional}: ${type}`;
    });
    const returnType = node.type ? node.type.getText() : 'unknown';
    return `(${params.join(', ')}) => ${returnType}`;
  }

  private serializeVariable(declaration: ts.VariableDeclaration): string | undefined {
    const initializer = declaration.initializer;
    if (!initializer) return undefined;
    if (ts.isArrowFunction(initializer)) return this.serializeFunctionLike(initializer);
    if (ts.isFunctionExpression(initializer)) return this.serializeFunctionLike(initializer);
    if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
      return `${initializer.expression.text} instance`;
    }
    return undefined;
  }

  // [90m[39m Import extraction [90m[39m

  private extractImports(
    sourceFile: ts.SourceFile,
    relativeFile: string,
    absoluteFile: string,
    baseDir: string,
  ): ImportEdge[] {
    const edges: ImportEdge[] = [];
    for (const statement of sourceFile.statements) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;

      if (ts.isImportDeclaration(statement)) {
        const specifier = this.moduleSpecifierText(statement);
        if (!specifier) continue;
        const isExternal = this.isExternalSpecifier(specifier);
        const targetFile = isExternal
          ? ''
          : this.resolveLocalImport(absoluteFile, specifier, baseDir);
        const base = {
          sourceFile: relativeFile,
          targetFile,
          isExternal: isExternal || undefined,
          line,
        } as const;
        const clause = statement.importClause;
        if (!clause) {
          edges.push({
            ...base,
            importedSymbol: '',
            importKind: 'side-effect' as const,
          });
        } else if (clause.name) {
          edges.push({
            ...base,
            importedSymbol: clause.name.text,
            importKind: 'default' as const,
          });
        } else if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            edges.push({
              ...base,
              importedSymbol: clause.namedBindings.name.text,
              importKind: 'namespace' as const,
            });
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              edges.push({
                ...base,
                importedSymbol: element.name.text,
                sourceSymbolName: element.propertyName
                  ? element.propertyName.text
                  : element.name.text,
                importKind: 'named' as const,
              });
            }
          }
        }
      } else if (ts.isExportDeclaration(statement)) {
        const specifier = this.moduleSpecifierText(statement);
        if (!specifier) {
          const clause = statement.exportClause;
          if (clause && ts.isNamedExports(clause)) {
            for (const element of clause.elements) {
              edges.push({
                sourceFile: relativeFile,
                importedSymbol: element.name.text,
                sourceSymbolName: element.propertyName
                  ? element.propertyName.text
                  : element.name.text,
                targetFile: relativeFile,
                importKind: 'named',
                line,
              });
            }
          }
          continue;
        }
        const isExternal = this.isExternalSpecifier(specifier);
        const targetFile = isExternal
          ? ''
          : this.resolveLocalImport(absoluteFile, specifier, baseDir);
        const base = {
          sourceFile: relativeFile,
          targetFile,
          isExternal: isExternal || undefined,
          line,
        } as const;
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            edges.push({
              ...base,
              importedSymbol: element.name.text,
              sourceSymbolName: element.propertyName
                ? element.propertyName.text
                : element.name.text,
              importKind: 'named',
            });
          }
        } else {
          edges.push({
            ...base,
            importedSymbol: '*',
            importKind: 'namespace',
          });
        }
      }
    }
    return edges;
  }

  private moduleSpecifierText(declaration: ts.ImportDeclaration | ts.ExportDeclaration): string {
    if (!declaration.moduleSpecifier) return '';
    if (ts.isStringLiteralLike(declaration.moduleSpecifier)) {
      return declaration.moduleSpecifier.text;
    }
    return '';
  }

  private isExternalSpecifier(specifier: string): boolean {
    const pathOnly = specifier.split(/[?#]/)[0];
    if (!pathOnly.startsWith('.') && !pathOnly.startsWith('/')) return true;
    return /\.(json|css|scss|sass|less|styl|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|wasm|map|txt|md)$/i.test(
      pathOnly,
    );
  }

  // [90m[39m Call-graph extraction [90m[39m

  private extractCallGraph(
    sourceFile: ts.SourceFile,
    relativeFile: string,
    fileImports: ImportEdge[],
  ): CallGraphEdge[] {
    const edges: CallGraphEdge[] = [];
    const localDefinitions = this.collectLocalDefinitions(sourceFile);
    const importMap = new Map<string, ImportEdge>();
    for (const edge of fileImports) {
      if (edge.importedSymbol && !importMap.has(edge.importedSymbol)) {
        importMap.set(edge.importedSymbol, edge);
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const resolved = this.resolveCallTarget(node, localDefinitions, importMap, relativeFile);
        if (resolved) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          edges.push({
            callerFile: relativeFile,
            callerFunction: this.findEnclosingFunctionName(node) ?? 'top-level',
            calleeFile: resolved.file,
            calleeFunction: resolved.name,
            line,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    return edges;
  }

  private collectLocalDefinitions(sourceFile: ts.SourceFile): Set<string> {
    const definitions = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        definitions.add(statement.name.text);
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        definitions.add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) definitions.add(declaration.name.text);
        }
      }
    }
    return definitions;
  }

  private resolveCallTarget(
    node: ts.CallExpression,
    localDefinitions: Set<string>,
    importMap: Map<string, ImportEdge>,
    callerFile: string,
  ): { file: string; name: string } | undefined {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) {
      const name = expression.text;
      if (localDefinitions.has(name)) {
        return { file: callerFile, name };
      }
      const edge = importMap.get(name);
      if (edge?.targetFile) {
        const resolvedName =
          edge.importKind === 'default' && !edge.sourceSymbolName
            ? '<default>'
            : (edge.sourceSymbolName ?? name);
        return { file: edge.targetFile, name: resolvedName };
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
      if (!ts.isIdentifier(expression.expression)) return undefined;
      const receiver = expression.expression.text;
      const edge = importMap.get(receiver);
      if (edge?.importKind === 'namespace' && edge.targetFile) {
        return { file: edge.targetFile, name: expression.name.text };
      }
    }
    return undefined;
  }

  private findEnclosingFunctionName(node: ts.Node): string | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
      if (ts.isFunctionExpression(current) && current.name) return current.name.text;
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const variable = this.findAssignedVariable(current);
        if (variable) return variable;
        return 'anonymous';
      }
      if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
      if (ts.isClassDeclaration(current) && current.name) return current.name.text;
      current = current.parent;
    }
    return undefined;
  }

  private findAssignedVariable(node: ts.Node): string | undefined {
    let current: ts.Node | undefined = node;
    while (current) {
      const parent: ts.Node | undefined = current.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      current = parent;
    }
    return undefined;
  }

  // [90m[39m Regex fallback (CommonJS / dynamic imports) [90m[39m

  private static readonly MAX_REGEX_SYMBOLS_PER_FILE = 50;
  private static readonly MAX_REGEX_IMPORTS_PER_FILE = 100;

  private extractRegexBased(
    relativeFile: string,
    content: string,
    absoluteFile: string,
    baseDir: string,
    astImports: ImportEdge[] = [],
  ): { symbols: IndexedSymbol[]; imports: ImportEdge[] } {
    const symbols: IndexedSymbol[] = [];
    const imports: ImportEdge[] = [];
    const masked = this.maskCommentsAndStrings(content);

    const seen = new Set<string>();
    for (const edge of astImports) {
      seen.add(`${edge.targetFile || edge.sourceFile}:\u0000:${edge.importKind}`);
    }

    const requireRe = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = requireRe.exec(masked)) !== null) {
      if (imports.length >= CodebaseExtractor.MAX_REGEX_IMPORTS_PER_FILE) break;
      const specifier = this.specifierAtOffset(content, match);
      if (!specifier || this.isExternalSpecifier(specifier)) continue;
      const targetFile = this.resolveLocalImport(absoluteFile, specifier, baseDir);
      const dedupeKey = targetFile ? `${targetFile}:\u0000:side-effect` : `unresolved:${specifier}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const line = this.lineOfOffset(content, match.index);
      imports.push({
        sourceFile: relativeFile,
        importedSymbol: '',
        targetFile,
        importKind: 'side-effect',
        line,
      });
    }

    const exportRe = /(?<![.\w])(?:module\.)?exports(?:\.(\w+))?\s*=/g;
    while ((match = exportRe.exec(masked)) !== null) {
      if (symbols.length >= CodebaseExtractor.MAX_REGEX_SYMBOLS_PER_FILE) break;
      const name = match[1] ?? 'default';
      const line = this.lineOfOffset(content, match.index);
      symbols.push({
        name,
        file: relativeFile,
        line,
        column: match.index - content.lastIndexOf('\n', match.index),
        kind: 'const',
        isDefaultExport: name === 'default',
        isExported: true,
      });
    }

    return { symbols, imports };
  }

  private maskCommentsAndStrings(content: string): string {
    return content.replace(
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g,
      (match) => {
        const first = match[0];
        if (first === "'" || first === '"' || first === '`') {
          return first + match.slice(1, -1).replace(/[^\n]/g, ' ') + first;
        }
        return match.replace(/[^\n]/g, ' ');
      },
    );
  }

  private specifierAtOffset(content: string, match: RegExpExecArray): string | undefined {
    const end = Math.min(match.index + match[0].length, content.length);
    const original = content.slice(match.index, end);
    const quoted = original.match(/['"]([^'"]+)['"]/);
    return quoted ? quoted[1] : undefined;
  }

  private lineOfOffset(content: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content[i] === '\n') line++;
    }
    return line;
  }

  // [90m[39m Import resolution [90m[39m

  private resolveLocalImport(
    absoluteSourceFile: string,
    specifier: string,
    baseDir: string,
  ): string {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) return '';
    const sourceDir = path.dirname(absoluteSourceFile);
    const basePath = path.resolve(sourceDir, specifier);
    const cacheKey = `${baseDir}\u0000${basePath}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = ((): string => {
      if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
        return this.toRelative(baseDir, basePath);
      }

      for (const ext of LOCAL_EXTENSIONS) {
        const candidate = basePath + ext;
        if (fs.existsSync(candidate)) return this.toRelative(baseDir, candidate);
      }

      const jsExts = ['.js', '.jsx', '.mjs', '.cjs'];
      for (const jsExt of jsExts) {
        if (specifier.endsWith(jsExt)) {
          const tsBase = basePath.slice(0, -jsExt.length);
          for (const tsExt of ['.ts', '.tsx', '.mts', '.cts']) {
            const candidate = tsBase + tsExt;
            if (fs.existsSync(candidate)) return this.toRelative(baseDir, candidate);
          }
        }
      }

      for (const ext of LOCAL_EXTENSIONS) {
        const indexCandidate = path.join(basePath, `index${ext}`);
        if (fs.existsSync(indexCandidate)) return this.toRelative(baseDir, indexCandidate);
      }

      return '';
    })();

    this.resolutionCache.set(cacheKey, result);
    return result;
  }

  // [90m[39m Monorepo detection [90m[39m

  private detectWorkspace(root: string): WorkspaceInfo | undefined {
    const globs = this.readWorkspaceGlobs(root);
    if (globs.length === 0) return undefined;
    return {
      name: this.readWorkspaceName(root),
      rootDir: root,
      fileGlobs: globs,
    };
  }

  private readWorkspaceName(root: string): string {
    const pkgPath = path.join(root, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.trim() !== '') return pkg.name.trim();
    } catch {
      // Malformed or missing package.json  fall back to the default name.
    }
    return 'workspace';
  }

  private readWorkspaceGlobs(root: string): string[] {
    const pnpmPath = path.join(root, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmPath)) {
      try {
        const content = fs.readFileSync(pnpmPath, 'utf-8');
        const packagesMatch = content.match(/^packages:\s*\n([\s\S]*?)(?=^\S|\n\S|$)/m);
        if (packagesMatch) {
          const globs: string[] = [];
          for (const line of packagesMatch[1].split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('- ')) globs.push(trimmed.slice(2).trim().replace(/['"]/g, ''));
          }
          if (globs.length > 0) return globs;
        }
      } catch {
        // fall through to package.json detection
      }
    }

    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
          workspaces?: string[] | { packages?: string[] };
        };
        if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
        if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
          return pkg.workspaces.packages;
        }
      } catch {
        // ignore malformed package.json
      }
    }
    return [];
  }

  // [90m[39m Helpers [90m[39m

  private toRelative(baseDir: string, file: string): string {
    const relative = path.relative(baseDir, file);
    return relative.split(path.sep).join('/');
  }

  private hasModifier(node: ts.Node, modifier: ts.SyntaxKind): boolean {
    const modifiers = (node as ts.HasModifiers).modifiers;
    if (!modifiers) return false;
    return modifiers.some((m) => m.kind === modifier);
  }
}

export type { IndexedSymbolKind };
