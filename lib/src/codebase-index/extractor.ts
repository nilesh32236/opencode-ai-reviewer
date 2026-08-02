import * as fs from 'fs';
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
  private readonly resolutionCache = new Map<string, string>();

  /**
   * @param options - Extraction options (workspace root override, include globs).
   */
  constructor(private readonly options: CodebaseExtractorOptions = {}) {
    this.workspaceDir = options.workspaceDir;
    this.includeGlobs = options.includeGlobs ?? [];
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
   * Asynchronous variant of {@link extract}. Uses promise-based filesystem APIs
   * for directory discovery and periodically yields to the event loop between
   * file reads/parses, so a large repository walk never blocks I/O handling or
   * concurrent reviews on a long-running process. Results are identical to the
   * synchronous variant.
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

    const symbols: IndexedSymbol[] = [];
    const imports: ImportEdge[] = [];
    const callGraph: CallGraphEdge[] = [];

    for (let i = 0; i < absoluteFiles.length; i++) {
      // Yield every 128 files so the event loop can service other work (webhook
      // handling, concurrent reviews) during a multi-second repository walk.
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

  /**
   * Extract symbols/imports/call edges for a single indexable file. Shared by
   * the synchronous and asynchronous extraction paths.
   *
   * @param file - Absolute path of the file to index.
   * @param baseDir - Base directory paths are reported relative to.
   * @returns The per-file extraction result.
   */
  private extractFile(
    file: string,
    baseDir: string,
  ): {
    symbols: IndexedSymbol[];
    imports: ImportEdge[];
    callGraph: CallGraphEdge[];
  } {
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
      content = fs.readFileSync(file, 'utf-8');
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
    // The TypeScript parser is error-tolerant and virtually never returns
    // `undefined` for JS-family input, so the regex pass must run *in
    // addition* to the AST pass — otherwise CommonJS `require()` /
    // dynamic `import()` / `module.exports` symbols in .js/.mjs/.cjs files
    // would never be indexed. TypeScript files get the same require()/
    // import() coverage AND the same `module.exports`/`exports.x` symbol
    // coverage (those are not `export` keywords, so the AST pass alone misses
    // CommonJS exports in mixed CJS/ESM .ts/.mts/.cts files; there is no
    // name-collision risk since AST identifiers cannot be named `default`).
    // Regex results are masked against comments/strings, deduped against AST
    // results, and capped per file so minified bundles cannot dominate the
    // index.
    if (!sourceFile || isJs || isTs) {
      const regex = this.extractRegexBased(relativeFile, content, file, baseDir, fileImports);
      if (isJs || isTs || !sourceFile) symbols.push(...regex.symbols);
      imports.push(...regex.imports);
    }
    return { symbols, imports, callGraph };
  }

  // ─── File discovery & parsing ───────────────────────────

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
          files.push(full);
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

  // ─── Symbol extraction ──────────────────────────────────

  private extractSymbols(sourceFile: ts.SourceFile, relativeFile: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    for (const statement of sourceFile.statements) {
      const pos = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
      const line = pos.line + 1;
      const column = pos.character + 1;

      if (ts.isFunctionDeclaration(statement)) {
        if (!statement.name) {
          // `export default function () {}` — an anonymous default-exported
          // function declaration. Synthesize a `default` symbol so the default
          // export is always represented (missing/renamed-default-export
          // detection needs it).
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
          // `export default class {}` — an anonymous default-exported class.
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

    // `export default someIdentifier;` — an ExportAssignment that references a
    // declaration made elsewhere in the file. Mark that declaration as the
    // default export so it is not reported as a missing export.
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

    // `export default (function () {})`, `export default (() => {})`, and
    // `export default (class {})` — anonymous default exports via expressions.
    // No named symbol exists, so synthesize a `default` symbol that reflects
    // the anonymous default export.
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

  // ─── Import extraction ──────────────────────────────────

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
          // Local re-export without a `from` clause: `export { foo, bar }`.
          // Record an edge back to this same module so the exported names are
          // visible to the index.
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

  /**
   * True when a module specifier refers to a package/node builtin or a known
   * non-code asset rather than a local source module. Asset imports
   * (`./styles.css`, `./data.json`) are not indexable by the extractor, so they
   * are treated as external and never reported as broken local imports.
   *
   * @param specifier - The raw module specifier (e.g. `./foo`, `zod`, `./data.json`).
   * @returns True when the specifier is external (bare or a non-code asset).
   */
  private isExternalSpecifier(specifier: string): boolean {
    // Strip the query string and fragment (`./icon.svg?url`, `./data.json?raw`)
    // before classification so asset imports with Vite/Next suffix patterns are
    // still treated as external and never reported as broken local imports.
    const pathOnly = specifier.split(/[?#]/)[0];
    if (!pathOnly.startsWith('.') && !pathOnly.startsWith('/')) return true;
    return /\.(json|css|scss|sass|less|styl|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|wasm|map|txt|md)$/i.test(
      pathOnly,
    );
  }

  // ─── Call-graph extraction ──────────────────────────────

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
        // Class names only — method names are excluded because a bare property
        // access (e.g. `console.log(...)`) would otherwise false-resolve to any
        // same-named method without a type-checker to prove the receiver.
        definitions.add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) definitions.add(declaration.name.text);
        }
      }
    }
    return definitions;
  }

  /**
   * Resolve a call expression to a local or imported target without a type
   * checker. Only unambiguous calls resolve:
   * - Bare identifier calls (`build(...)`) that match a local top-level symbol
   *   or a named/default import.
   * - Member calls (`utils.normalize(...)`) whose receiver is a namespace
   *   import binding pointing at a resolvable local module.
   *
   * Arbitrary property calls (`console.log(...)`, `json.parse(...)`) never
   * resolve, because the receiver type is unknown in a pure syntactic parse and
   * would produce misleading caller/callee edges.
   *
   * @param node - The call expression to resolve.
   * @param localDefinitions - Local top-level symbol names in the same file.
   * @param importMap - Named/namespace imports of the file keyed by binding name.
   * @param callerFile - File path (relative to the indexed root) containing the call.
   * @returns The resolved target `{ file, name }`, or undefined when ambiguous.
   */
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
        // A default import binds the local alias (e.g. `build` for
        // `import build from './x.js'`) but the callee's real symbol name in
        // the target module is unknown without a type checker. Reference the
        // module's default export explicitly instead of inventing a callee
        // that does not exist there.
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

  // ─── Regex fallback (CommonJS / dynamic imports) ────────

  /** Cap on regex-extracted symbols per file so minified bundles cannot flood the index. */
  private static readonly MAX_REGEX_SYMBOLS_PER_FILE = 50;
  /** Cap on regex-extracted import edges per file so minified bundles cannot flood the index. */
  private static readonly MAX_REGEX_IMPORTS_PER_FILE = 100;

  /**
   * Extract CommonJS `require()` / dynamic `import()` edges and `module.exports`
   * symbol names. The scan runs over a copy of the source with comments and
   * string/template literals masked (length-preserving) so commented-out or
   * string-embedded `require()`/`module.exports` text never produces phantom
   * entries. Results are deduped against the AST-extracted imports for the same
   * file (a static `import './x.js'` next to `require('./x.js')` yields a
   * single edge) and capped per file.
   *
   * @param relativeFile - File path relative to the indexed root.
   * @param content - Raw file content (used for accurate line/column numbers).
   * @param absoluteFile - Absolute path of the file.
   * @param baseDir - Base directory resolved paths are reported relative to.
   * @param astImports - Import edges already extracted from the AST pass for this file.
   * @returns Regex-extracted symbols and import edges.
   */
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

    // Dedupe against AST edges by (target or specifier, kind) so a static
    // side-effect import next to a `require()` of the same module is not
    // reported twice. Unresolved local specifiers dedupe by specifier.
    const seen = new Set<string>();
    for (const edge of astImports) {
      seen.add(`${edge.targetFile || edge.sourceFile}:\u0000:${edge.importKind}`);
    }

    // `require('...')` and `import('...')` calls.
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

    // `module.exports = ...` and `exports.foo = ...` for CommonJS symbol names.
    // The negative lookbehind requires a non-word/non-dot boundary before
    // `exports` so `obj.exports = 2` or `fooexports.bar = 3` never produce
    // phantom exported symbols.
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

  /**
   * Replace comments and string/template literals with spaces, preserving the
   * original length and newlines so match offsets stay valid for line/column
   * computation. String delimiters are kept so the `require('...')` pattern can
   * still be located; the actual specifier is read back from the raw content by
   * {@link specifierAtOffset}.
   *
   * @param content - Raw file content.
   * @returns The content with comments/strings masked.
   */
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

  /**
   * Read the actual module specifier from the raw content at a regex match that
   * was found on the masked content (whose string bodies are blanked).
   *
   * @param content - Raw file content.
   * @param match - Regex match on the masked content.
   * @returns The unquoted specifier, or undefined when none is present.
   */
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

  // ─── Import resolution ──────────────────────────────────

  /**
   * Resolve a local import specifier (relative to the importing file) to a
   * file path on disk. Tries exact paths, common extensions, the `.js`→`.ts`
   * ESM mapping, and `index.*` resolution.
   *
   * @param absoluteSourceFile - Absolute path of the importing file.
   * @param specifier - The raw module specifier (e.g. `./foo`, `../bar.js`).
   * @param baseDir - Base directory the result is reported relative to.
   * @returns Resolved path relative to `baseDir` (forward slashes), or '' when unresolvable.
   */
  private resolveLocalImport(
    absoluteSourceFile: string,
    specifier: string,
    baseDir: string,
  ): string {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) return '';
    const sourceDir = path.dirname(absoluteSourceFile);
    const basePath = path.resolve(sourceDir, specifier);
    // Memoize per (baseDir, basePath): many files in the same directory import
    // the same module, and each resolution can probe the filesystem ~20 times.
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

      // `.js` → `.ts` ESM convention: `import './foo.js'` maps to `./foo.ts`.
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

  // ─── Monorepo detection ─────────────────────────────────

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
      // Malformed or missing package.json — fall back to the default name.
    }
    return 'workspace';
  }

  private readWorkspaceGlobs(root: string): string[] {
    // pnpm-workspace.yaml
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

    // package.json `workspaces` field.
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

  // ─── Helpers ────────────────────────────────────────────

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
