/** Kinds of top-level symbols the codebase index can extract. */
export type IndexedSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'enum'
  | 'variable';

/** A top-level symbol extracted from a source file. */
export interface IndexedSymbol {
  /** Symbol name (e.g. `parseInput`, `HttpClient`). */
  name: string;
  /** File path relative to the indexed root (forward slashes). */
  file: string;
  /** 1-based line where the symbol is declared. */
  line: number;
  /** 1-based column where the symbol is declared. */
  column: number;
  /** Kind of the declared symbol. */
  kind: IndexedSymbolKind;
  /** Serialized signature for functions/methods/const arrow functions, e.g. `(a: string, b: number) => boolean`. */
  signature?: string;
  /** Whether the symbol is a default export. */
  isDefaultExport: boolean;
  /** Whether the symbol is exported (named or default) from its module. */
  isExported: boolean;
}

/** Kind of an import/export relationship edge. */
export type ImportKind = 'named' | 'default' | 'namespace' | 'side-effect';

/** A directed import/re-export relationship between two files. */
export interface ImportEdge {
  /** File path (relative to the indexed root) doing the import. */
  sourceFile: string;
  /** Name of the imported symbol (`*` for `export * from`, empty for side-effect imports). */
  importedSymbol: string;
  /** Original symbol name in the target module (when the import is aliased). */
  sourceSymbolName?: string;
  /** Resolved file path (relative to the indexed root) of the imported module. Empty when the specifier could not be resolved to a local file. */
  targetFile: string;
  /** True when the specifier is a bare package/node builtin specifier rather than a local path. External edges are not reported as broken imports. */
  isExternal?: boolean;
  /** Kind of import relationship. */
  importKind: ImportKind;
  /** 1-based line where the import statement appears. */
  line: number;
}

/** A caller→callee edge in the function call graph. */
export interface CallGraphEdge {
  /** File path (relative to the indexed root) containing the call site. */
  callerFile: string;
  /** Name of the enclosing function of the call site (`top-level` for module-scope calls). */
  callerFunction: string;
  /** File path (relative to the indexed root) where the callee is defined. */
  calleeFile: string;
  /** Name of the called function. */
  calleeFunction: string;
  /** 1-based line of the call expression. */
  line: number;
}

/** Monorepo workspace metadata attached to an index. */
export interface WorkspaceInfo {
  /** Workspace package name. */
  name: string;
  /** Workspace root directory (absolute). */
  rootDir: string;
  /** Glob patterns covering the workspace packages. */
  fileGlobs: string[];
}

/** The complete codebase index for a given git ref. */
export interface CodebaseIndexData {
  /** Git ref SHA the index was built from (empty for a fresh extractor result). */
  refSha: string;
  /** Extracted top-level symbols across indexed files. */
  symbols: IndexedSymbol[];
  /** Import/re-export edges across indexed files. */
  imports: ImportEdge[];
  /** Caller→callee edges across indexed files. */
  callGraph: CallGraphEdge[];
  /** Monorepo workspace info, when one is detected. */
  workspace?: WorkspaceInfo;
  /** Wall-clock build time in milliseconds. */
  buildTimeMs: number;
}

/** Cross-file context relevant to a specific set of changed files. */
export interface CodebaseContext {
  /** Symbols defined in the changed files. */
  localSymbols: IndexedSymbol[];
  /** Symbols exported from the changed files. */
  exportedSymbols: IndexedSymbol[];
  /** Imports that either originate from or target the changed files. */
  affectedImports: ImportEdge[];
  /** Call edges where an external caller invokes a symbol in a changed file. */
  affectedCallers: CallGraphEdge[];
  /** Call edges where a changed file invokes a symbol defined elsewhere. */
  affectedCallees: CallGraphEdge[];
  /** Monorepo workspace metadata, when one was detected for the indexed root. */
  workspace?: WorkspaceInfo;
  /** Workspace package globs that match at least one changed file. */
  matchedWorkspaceGlobs?: string[];
}
