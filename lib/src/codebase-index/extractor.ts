import * as fs from 'fs';
import * as path from 'path';
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
    const start = Date.now();
    const root = path.resolve(rootDir);
    const baseDir = this.workspaceDir ? path.resolve(this.workspaceDir) : root;

    const fileList = files && files.length > 0 ? files : undefined;
    const absoluteFiles = this.resolveFiles(root, fileList);

    const symbols: IndexedSymbol[] = [];
    const imports: ImportEdge[] = [];
    const callGraph: CallGraphEdge[] = [];

    for (const file of absoluteFiles) {
      if (!this.isIndexableFile(file)) continue;
      const relativeFile = this.toRelative(baseDir, file);
      if (this.includeGlobs.length > 0 && !this.matchesGlobs(relativeFile)) continue;
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const sourceFile = this.parseSourceFile(file, content);
      if (sourceFile) {
        symbols.push(...this.extractSymbols(sourceFile, relativeFile));
        const fileImports = this.extractImports(sourceFile, relativeFile, file, baseDir);
        imports.push(...fileImports);
        callGraph.push(...this.extractCallGraph(sourceFile, relativeFile, fileImports));
      } else {
        // Unparsable or non-TS file — fall back to regex extraction.
        const regex = this.extractRegexBased(relativeFile, content, file, baseDir);
        symbols.push(...regex.symbols);
        imports.push(...regex.imports);
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
    return this.includeGlobs.some((glob) => {
      if (glob.endsWith('/**')) {
        return normalized.startsWith(glob.slice(0, -3)) || normalized === glob.slice(0, -3);
      }
      if (glob.includes('*')) {
        const re = new RegExp(
          '^' +
            glob
              .split('*')
              .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('.*') +
            '$',
        );
        return re.test(normalized);
      }
      return normalized === glob;
    });
  }

  // ─── Symbol extraction ──────────────────────────────────

  private extractSymbols(sourceFile: ts.SourceFile, relativeFile: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    for (const statement of sourceFile.statements) {
      const pos = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
      const line = pos.line + 1;
      const column = pos.character + 1;

      if (ts.isFunctionDeclaration(statement)) {
        if (!statement.name) continue;
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
        if (!statement.name) continue;
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
        const targetFile = this.resolveLocalImport(absoluteFile, specifier, baseDir);
        const clause = statement.importClause;
        if (!clause) {
          edges.push({
            sourceFile: relativeFile,
            importedSymbol: '',
            targetFile,
            importKind: 'side-effect',
            line,
          });
        } else if (clause.name) {
          edges.push({
            sourceFile: relativeFile,
            importedSymbol: clause.name.text,
            targetFile,
            importKind: 'default',
            line,
          });
        } else if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            edges.push({
              sourceFile: relativeFile,
              importedSymbol: clause.namedBindings.name.text,
              targetFile,
              importKind: 'namespace',
              line,
            });
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              edges.push({
                sourceFile: relativeFile,
                importedSymbol: element.name.text,
                sourceSymbolName: element.propertyName
                  ? element.propertyName.text
                  : element.name.text,
                targetFile,
                importKind: 'named',
                line,
              });
            }
          }
        }
      } else if (ts.isExportDeclaration(statement)) {
        // Re-exports: `export { a } from './x'` and `export * from './x'`.
        const specifier = this.moduleSpecifierText(statement);
        if (!specifier) continue;
        const targetFile = this.resolveLocalImport(absoluteFile, specifier, baseDir);
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            edges.push({
              sourceFile: relativeFile,
              importedSymbol: element.name.text,
              sourceSymbolName: element.propertyName
                ? element.propertyName.text
                : element.name.text,
              targetFile,
              importKind: 'named',
              line,
            });
          }
        } else {
          edges.push({
            sourceFile: relativeFile,
            importedSymbol: '*',
            targetFile,
            importKind: 'namespace',
            line,
          });
        }
      }
    }
    return edges;
  }

  private moduleSpecifierText(declaration: ts.ImportDeclaration | ts.ExportDeclaration): string {
    if (!declaration.moduleSpecifier) return '';
    const text = declaration.moduleSpecifier.getText();
    return text.replace(/['"]/g, '');
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
        const calleeName = this.calleeName(node);
        if (calleeName) {
          const resolved = this.resolveCallee(
            calleeName,
            localDefinitions,
            importMap,
            relativeFile,
          );
          if (resolved) {
            const line =
              sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            edges.push({
              callerFile: relativeFile,
              callerFunction: this.findEnclosingFunctionName(node) ?? 'top-level',
              calleeFile: resolved.file,
              calleeFunction: resolved.name,
              line,
            });
          }
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
        for (const member of statement.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            definitions.add(member.name.getText());
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) definitions.add(declaration.name.text);
        }
      }
    }
    return definitions;
  }

  private calleeName(node: ts.CallExpression): string | undefined {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
      return expression.name.text;
    }
    if (ts.isElementAccessExpression(expression)) {
      const argument = expression.argumentExpression;
      if (argument && ts.isStringLiteralLike(argument)) return argument.text;
    }
    return undefined;
  }

  private resolveCallee(
    name: string,
    localDefinitions: Set<string>,
    importMap: Map<string, ImportEdge>,
    callerFile: string,
  ): { file: string; name: string } | undefined {
    if (localDefinitions.has(name)) {
      return { file: callerFile, name };
    }
    const edge = importMap.get(name);
    if (edge?.targetFile) {
      return { file: edge.targetFile, name: edge.sourceSymbolName ?? name };
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

  private extractRegexBased(
    relativeFile: string,
    content: string,
    absoluteFile: string,
    baseDir: string,
  ): { symbols: IndexedSymbol[]; imports: ImportEdge[] } {
    const symbols: IndexedSymbol[] = [];
    const imports: ImportEdge[] = [];

    // `require('...')` and `import('...')` calls.
    const requireRe = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = requireRe.exec(content)) !== null) {
      const specifier = match[1];
      if (!specifier || !specifier.startsWith('.')) continue;
      const targetFile = this.resolveLocalImport(absoluteFile, specifier, baseDir);
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
    const exportRe = /(?:module\.)?exports(?:\.(\w+))?\s*=/g;
    while ((match = exportRe.exec(content)) !== null) {
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
  }

  // ─── Monorepo detection ─────────────────────────────────

  private detectWorkspace(root: string): WorkspaceInfo | undefined {
    const globs = this.readWorkspaceGlobs(root);
    if (globs.length === 0) return undefined;
    return {
      name: 'workspace',
      rootDir: root,
      fileGlobs: globs,
    };
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
