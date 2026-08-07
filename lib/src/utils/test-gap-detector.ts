import * as fs from 'fs';
import { execFileSync } from 'node:child_process';
import * as path from 'path';
import type { ChangedFile } from '../types/index.js';

/**
 * A single exported symbol extracted from a source file.
 */
export interface SourceSymbol {
  /** Symbol name as exported ('default' for anonymous default exports). */
  name: string;
  /** Kind of the export declaration. */
  kind: 'function' | 'class' | 'const' | 'default' | 'interface' | 'type' | 'reexport';
  /** Repo-relative source file path. */
  file: string;
  /** 1-based line where the export declaration starts. */
  line: number;
  /** 1-based line where the symbol body ends (best-effort brace matching). */
  endLine: number;
  /** Whether the symbol body contains error-handling constructs (throw / reject / new Error). */
  hasErrorHandling?: boolean;
  /** Detected error-path labels (e.g. `throw` / `reject`) present in the body. */
  errorPaths?: string[];
}

/**
 * A detected test gap for a single source symbol.
 */
export interface TestGapEntry {
  /** Repo-relative source file path. */
  sourceFile: string;
  /** Name of the affected exported symbol. */
  symbolName: string;
  /** Repo-relative test file path when one could be mapped. */
  testFile?: string;
  /** Human-readable reason for the gap. */
  reason: string;
  /** Detected error paths (e.g. `throw` statements) for error-handling gaps. */
  errorPaths?: string[];
}

/** Kind of test suggestion generated from a detected gap. */
export type TestSuggestionType = 'missing-test' | 'update-test' | 'error-case';

/** A suggested test file / test case derived from a detected gap. */
export interface TestSuggestion {
  /** Repo-relative source file path. */
  sourceFile: string;
  /** Name of the affected exported symbol. */
  symbolName: string;
  /** Suggested test file path following the repo's test conventions. */
  suggestedTestPath: string;
  /** Why the suggestion is made. */
  suggestionType: TestSuggestionType;
}

/**
 * Structured result of a test-gap analysis pass.
 */
export interface TestGapResult {
  /** Modified source symbols whose mapped test file was NOT updated in the PR. */
  modifiedUnchangedTests: TestGapEntry[];
  /** Newly added exports with no test coverage. */
  newUntestedExports: TestGapEntry[];
  /** Symbols with error-handling paths lacking error-case tests. */
  missingErrorCaseTests: TestGapEntry[];
  /** Suggested test files / cases derived from the detected gaps. */
  testSuggestions: TestSuggestion[];
  /** Formatted markdown ready for injection into the review prompt ('' when no gaps). */
  contextString: string;
}

/** Source file extensions considered for test-gap analysis. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

/** Test file name markers in the convention `<base>.test.<ext>` / `<base>.spec.<ext>`. */
const TEST_MARKERS = ['.test', '.spec'];

/** Upper bound (bytes) for a changed source file read into the analyzer; larger
 * files (vendored bundles, generated code) are skipped so analysis stays fast. */
const MAX_ANALYSIS_FILE_BYTES = 2 * 1024 * 1024;

/** Timeout for the synchronous `git show` fallback read, mirroring the SCA
 * scan deadline pattern so a hung git process cannot block the review. */
const GIT_READ_TIMEOUT_MS = 10_000;

/** Anchored (linear) check for a valid JS identifier, used to validate export names. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/** Export declaration patterns matched during symbol extraction. */
const EXPORT_PATTERNS: Array<{ kind: SourceSymbol['kind']; regex: RegExp }> = [
  { kind: 'function', regex: /export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'function', regex: /export\s+function\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'class', regex: /export\s+abstract\s+class\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'class', regex: /export\s+class\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'const', regex: /export\s+const\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'interface', regex: /export\s+interface\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'type', regex: /export\s+type\s+([A-Za-z_$][\w$]*)/g },
  {
    kind: 'default',
    regex: /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
  },
  {
    kind: 'default',
    regex: /export\s+default\s+(?!(?:async\s+)?(?:function|class)\b)([A-Za-z_$][\w$]*)/g,
  },
  {
    kind: 'default',
    regex:
      /export\s+default\s+(?:(?:async\s+)?function\s*\(|class\s*(?:\{|$)|\(|\{|[A-Za-z_$][\w$]*\s*=>)/g,
  },
  { kind: 'reexport', regex: /export\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g },
];

/** Error-handling constructs looked for inside a symbol body, labeled by the
 * error path they represent so `errorPaths` reflects what was actually found. */
const ERROR_PATH_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'throw', regex: /\bthrow\s+new\s+Error/g },
  { label: 'throw', regex: /\bthrow\s+/g },
  { label: 'reject', regex: /\.reject\s*\(/g },
  { label: 'reject', regex: /\breject\s*\(\s*new\s+Error/g },
  { label: 'reject', regex: /\breject\s*\(\s*err/g },
];

/** Error-case assertions looked for inside a test file body. */
const TEST_ERROR_PATTERNS = [
  /\.rejects\b/g,
  /\.rejects\.to/g,
  /\.toThrow\s*\(/g,
  /\.toThrowError\s*\(/g,
  /assert\.rejects/g,
  /assert\.throws/g,
  /\bthrows\b/g,
  /\brejects\b/g,
  /\bcatch\s*\(\s*err/g,
];

/** Symbol kinds that carry runtime behaviour and can be covered by a test.
 * Type/interface declarations and re-exports have no runtime body of their
 * own, so they are never reported as test gaps. */
const TESTABLE_KINDS: ReadonlySet<SourceSymbol['kind']> = new Set([
  'function',
  'class',
  'const',
  'default',
]);

/**
 * Best-effort line-range detection for a `{` ... `}` block found at the given
 * offset in `lines`. Returns the index of the line where the block closes.
 * @param lines - All source lines of the file.
 * @param startLine - 0-based index of the line that opens the block.
 * @param openLineText - The text of the opening line.
 * @returns The 0-based index of the line where the block closes, or `startLine`
 * when the block never closes.
 */
function findBlockEnd(lines: string[], startLine: number, openLineText: string): number {
  const opens = (openLineText.match(/\{/g) || []).length;
  const closes = (openLineText.match(/\}/g) || []).length;
  // Statement is self-contained on one line (e.g. `export const X = { a: 1 };`).
  if (opens === closes) return startLine;
  let depth = opens - closes;
  for (let i = startLine + 1; i < lines.length; i++) {
    const text = lines[i];
    const o = (text.match(/\{/g) || []).length;
    const c = (text.match(/\}/g) || []).length;
    depth += o - c;
    if (depth <= 0) return i;
  }
  return startLine;
}

/**
 * Map a character offset to its 0-based line index using precomputed newline
 * positions via binary search (O(log n) per lookup).
 * @param offset - The character offset in the file content.
 * @param newlineOffsets - Sorted positions of `\n` characters in the content.
 * @returns The 0-based line index containing `offset`.
 */
function lineIndexAtCharOffset(offset: number, newlineOffsets: number[]): number {
  let lo = 0;
  let hi = newlineOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlineOffsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Extract the exported symbols declared in a source file.
 * @param filePath - Absolute path to the source file to analyze.
 * @param relativePath - Optional repo-relative path used for attribution; when
 * omitted the absolute `filePath` is used so `SourceSymbol.file` stays
 * resolvable by `findTestFile`.
 * @returns The list of exported symbols in declaration order.
 */
export function extractExports(filePath: string, relativePath?: string): SourceSymbol[] {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  return extractExportsFromContent(content, relativePath ?? filePath);
}

/**
 * Extract exported symbols from raw file content.
 * @param content - The source file content.
 * @param file - Repo-relative (or logical) file path used for attribution.
 * @returns The list of exported symbols in declaration order.
 */
export function extractExportsFromContent(content: string, file: string): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  const lines = content.split('\n');
  const joined = content;
  // Precompute newline offsets once so the per-match line lookup is a binary
  // search instead of an O(n) re-split of the whole prefix for every match.
  const newlineOffsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) newlineOffsets.push(i);
  }

  for (const { kind, regex } of EXPORT_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(joined)) !== null) {
      const lineOffset = lineIndexAtCharOffset(match.index, newlineOffsets);
      const line = lineOffset + 1;
      const lineText = lines[lineOffset] ?? '';
      let name = match[1] ?? 'default';
      let names: string[] | undefined;
      if (kind === 'reexport') {
        // `export { foo as bar, baz } from './x'` → one symbol per exported name.
        // The `as` alias is parsed with a linear split (no backtracking regex)
        // so untrusted re-export lists cannot trigger ReDoS.
        names = match[1]
          .split(',')
          .map((part) => {
            const segments = part.trim().split(/\s+as\s+/);
            if (
              segments.length === 2 &&
              IDENTIFIER_RE.test(segments[0]) &&
              IDENTIFIER_RE.test(segments[1])
            ) {
              return segments[1];
            }
            return part.trim();
          })
          .filter((part) => IDENTIFIER_RE.test(part));
        name = names[0] ?? 'default';
      }

      // Skip matches inside comments to reduce false positives.
      const before = joined.slice(0, match.index);
      const lastNewline = before.lastIndexOf('\n');
      const inComment =
        before.lastIndexOf('/*') > before.lastIndexOf('*/') ||
        before.lastIndexOf('//') > lastNewline;
      if (inComment) continue;

      let endLine = line;
      if (kind === 'reexport') {
        // `export { foo } from './x'` is a one-liner by construction.
        endLine = line;
      } else if (lineText.includes('{')) {
        endLine = findBlockEnd(lines, lineOffset, lineText) + 1;
      }

      if (names) {
        for (const n of names) {
          symbols.push({ name: n, kind, file, line, endLine, hasErrorHandling: false });
        }
      } else {
        symbols.push({ name, kind, file, line, endLine, hasErrorHandling: false });
      }

      // Re-wind the regex so overlapping exports (rare) don't consume matches.
      regex.lastIndex = match.index + match[0].length;
    }
  }

  for (const symbol of symbols) {
    symbol.errorPaths = errorPathsInRange(lines, symbol.line, symbol.endLine);
    symbol.hasErrorHandling = symbol.errorPaths.length > 0;
  }

  return dedupeSymbols(symbols);
}

/**
 * Remove duplicate symbol entries (e.g. `export default foo` matched twice).
 * @param symbols - Extracted symbols, possibly containing duplicates.
 * @returns The deduplicated symbols, sorted by declaration line.
 */
function dedupeSymbols(symbols: SourceSymbol[]): SourceSymbol[] {
  const seen = new Set<string>();
  const unique: SourceSymbol[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.file}:${symbol.name}:${symbol.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol);
  }
  return unique.sort((a, b) => a.line - b.line);
}

/**
 * Detect the distinct error-path constructs present in a line range.
 * @param lines - All source lines of the file.
 * @param startLine - 1-based start line of the range.
 * @param endLine - 1-based end line of the range (inclusive).
 * @returns The distinct error-path labels (e.g. `throw`, `reject`) found in the range.
 */
function errorPathsInRange(lines: string[], startLine: number, endLine: number): string[] {
  const body = lines.slice(startLine - 1, endLine).join('\n');
  const labels = new Set<string>();
  for (const { label, regex } of ERROR_PATH_PATTERNS) {
    // Reset lastIndex so the shared global patterns yield order-independent
    // results across repeated calls.
    regex.lastIndex = 0;
    if (regex.test(body)) labels.add(label);
  }
  return [...labels];
}

/**
 * Whether a repo-relative path points at a test file (`.test.`/`.spec.` marker
 * or a `__tests__` directory).
 * @param filePath - Repo-relative file path to classify.
 * @returns True when the path looks like a test file.
 */
export function isTestFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return TEST_MARKERS.some((marker) => base.includes(marker)) || /__tests__/.test(filePath);
}

/**
 * Map a source file path to a matching test file using conventional naming.
 * Candidate conventions (first existing file wins):
 *  - `<dir>/<base>.test.<ext>` and `<dir>/<base>.spec.<ext>`
 *  - `<dir>/__tests__/<base>.<ext>` (+ `.test`/`.spec` variants)
 *  - `<dir>/tests/<base>.<ext>` (+ `.test`/`.spec` variants)
 *  - `<root>/tests/<path-after-src>.test.<ext>` mirror (e.g. `src/foo.ts` → `tests/foo.test.ts`)
 * @param sourceFilePath - Repo-relative source file path (e.g. `src/foo.ts`).
 * @param workDir - Repository working directory to resolve files against.
 * @returns The repo-relative test file path, or `null` when no convention file exists.
 */
export function findTestFile(sourceFilePath: string, workDir: string): string | null {
  const candidates = buildTestFileCandidates(sourceFilePath);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(workDir, candidate))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Build the conventional test-file candidates for a source path.
 * @param sourceFilePath - Repo-relative source file path.
 * @returns Candidate test file paths in priority order.
 */
export function buildTestFileCandidates(sourceFilePath: string): string[] {
  const dir = path.posix.dirname(sourceFilePath);
  const ext = path.posix.extname(sourceFilePath);
  const base = path.posix.basename(sourceFilePath, ext);
  const candidates: string[] = [];

  for (const marker of TEST_MARKERS) {
    candidates.push(path.posix.join(dir, `${base}${marker}${ext}`));
  }
  for (const marker of ['', ...TEST_MARKERS]) {
    candidates.push(path.posix.join(dir, '__tests__', `${base}${marker}${ext}`));
  }
  for (const marker of ['', ...TEST_MARKERS]) {
    candidates.push(path.posix.join(dir, 'tests', `${base}${marker}${ext}`));
  }

  // `<pkg>/src/` tree mirror: `src/foo.ts` → `tests/foo.test.ts` at the root
  // and `lib/src/foo.ts` → `lib/tests/foo.test.ts` inside a monorepo package,
  // preserving any subdirectories under `src/`.
  const parts = sourceFilePath.split('/');
  const srcIndex = parts.indexOf('src');
  if (srcIndex !== -1) {
    const mirrorDir = parts.slice(0, srcIndex).concat(['tests']).join('/');
    const remainder = parts.slice(srcIndex + 1, -1).join('/');
    const mirrorBase = remainder ? `${remainder}/${base}` : base;
    for (const marker of TEST_MARKERS) {
      candidates.push(path.posix.join(mirrorDir, `${mirrorBase}${marker}${ext}`));
    }
    candidates.push(path.posix.join(mirrorDir, `${mirrorBase}${ext}`));
  }

  return candidates;
}

/**
 * Primary conventional test path for a source file (may not exist yet); used
 * for suggestions.
 * @param sourceFilePath - Repo-relative source file path.
 * @returns The suggested test file path in `<dir>/<base>.test.<ext>` form.
 */
export function suggestTestPath(sourceFilePath: string): string {
  const dir = path.posix.dirname(sourceFilePath);
  const ext = path.posix.extname(sourceFilePath);
  const base = path.posix.basename(sourceFilePath, ext);
  return path.posix.join(dir, `${base}${TEST_MARKERS[0]}${ext}`);
}

/**
 * Parse a unified diff patch and return the set of NEW-file line numbers it touches.
 * @param patch - Optional unified diff patch text.
 * @returns The set of new-file line numbers the patch touches.
 */
export function parsePatchTouchedNewLines(patch?: string): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)/);
      newLine = match ? Number(match[1]) : 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('-')) continue;
    if (line.startsWith('+')) {
      if (newLine > 0) lines.add(newLine);
      newLine++;
      continue;
    }
    if (line.startsWith(' ')) {
      newLine++;
      continue;
    }
    if (line.startsWith('\\')) continue;
    inHunk = false;
  }
  return lines;
}

/**
 * Filter symbols whose `[line, endLine]` range overlaps any touched new line.
 * @param symbols - Extracted source symbols.
 * @param touched - Set of new-file line numbers touched by the patch.
 * @returns The symbols whose body range overlaps a touched line.
 */
function symbolsTouchedByPatch(symbols: SourceSymbol[], touched: Set<number>): SourceSymbol[] {
  if (touched.size === 0) return [];
  return symbols.filter((symbol) => {
    for (let n = symbol.line; n <= symbol.endLine; n++) {
      if (touched.has(n)) return true;
    }
    return false;
  });
}

/**
 * Read the previous revision of a file from git (best-effort).
 * Uses `execFileSync` with an argument array (no shell) so the file path —
 * which originates from PR changed-file metadata — can never be interpreted
 * as a shell command.
 * @param workDir - Repository working directory.
 * @param file - Repo-relative file path to read at HEAD.
 * @returns The file content at HEAD, or `null` when unavailable.
 */
function readFileAtHead(workDir: string, file: string): string | null {
  try {
    const result = execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Bound the sync git call so a hung git process (lock contention, slow
      // network filesystem) can never block the whole review indefinitely.
      timeout: GIT_READ_TIMEOUT_MS,
    });
    return result as string;
  } catch {
    return null;
  }
}

/**
 * Detects test gaps between changed source files and their corresponding tests.
 *
 * Uses lightweight regex + convention-based mapping (no runtime compiler
 * dependency) and produces structured gaps plus a markdown context string for
 * injection into the review prompt. Best-effort: any missing/unreadable file
 * is skipped and never crashes the review.
 */
export class TestGapDetector {
  /** Per-analyze memo of `symbol.file` → mapped test file (null = none). */
  private testFileCache = new Map<string, string | null>();
  /** Per-analyze memo of test file path → its content (null = unreadable). */
  private testContentCache = new Map<string, string | null>();

  /**
   * Run a full test-gap analysis for a set of changed files.
   * @param changedFiles - The PR's changed files.
   * @param workDir - Repository working directory to read files from.
   * @returns Structured gap results and a markdown context string.
   */
  analyze(changedFiles: ChangedFile[], workDir: string): TestGapResult {
    this.testFileCache.clear();
    this.testContentCache.clear();

    const sourceFiles = changedFiles.filter(
      (f) => !isTestFile(f.path) && SOURCE_EXTENSIONS.has(path.posix.extname(f.path)),
    );
    const changedTestFileSet = new Set(
      changedFiles.filter((f) => isTestFile(f.path)).map((f) => f.path),
    );

    const modifiedSymbols: SourceSymbol[] = [];
    const newSymbols: SourceSymbol[] = [];

    for (const file of sourceFiles) {
      if (file.status === 'removed') continue;
      const fullPath = path.join(workDir, file.path);
      // Best-effort: a missing, unreadable, oversized, or directory entry is
      // skipped and never crashes the review.
      let content = '';
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size > MAX_ANALYSIS_FILE_BYTES) continue;
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }
      if (!content) continue;

      const exports = extractExportsFromContent(content, file.path);

      if (file.status === 'added') {
        newSymbols.push(...exports);
        continue;
      }

      // Determine which symbols this PR actually touched.
      const touched = parsePatchTouchedNewLines(file.patch);
      if (touched.size > 0) {
        modifiedSymbols.push(...symbolsTouchedByPatch(exports, touched));
      } else {
        // No patch (e.g. GitLab). Fall back to comparing against the previous
        // revision when git is available. The symbol NAME is the stable key —
        // line numbers shift whenever lines are inserted or deleted above a
        // symbol, which would otherwise misclassify exports as new.
        const oldContent = readFileAtHead(workDir, file.path);
        if (oldContent !== null) {
          const oldExports = extractExportsFromContent(oldContent, file.path);
          const oldByName = new Map(oldExports.map((s) => [s.name, s]));
          const oldLines = oldContent.split('\n');
          const newLines = content.split('\n');
          for (const symbol of exports) {
            const previous = oldByName.get(symbol.name);
            if (previous === undefined) {
              // New symbol in a modified file.
              newSymbols.push(symbol);
            } else {
              const oldBody = oldLines.slice(previous.line - 1, previous.endLine).join('\n');
              const newBody = newLines.slice(symbol.line - 1, symbol.endLine).join('\n');
              if (oldBody !== newBody) modifiedSymbols.push(symbol);
            }
          }
        }
      }
    }

    const modifiedUnchangedTests = this.detectModifiedUnchangedTests(
      modifiedSymbols,
      changedTestFileSet,
      workDir,
    );
    const newUntestedExports = this.detectNewUntestedExports(
      newSymbols,
      changedTestFileSet,
      workDir,
    );
    const missingErrorCaseTests = this.detectErrorHandlingGaps(
      [...modifiedSymbols, ...newSymbols],
      workDir,
    );

    const testSuggestions = this.buildSuggestions(
      modifiedUnchangedTests,
      newUntestedExports,
      missingErrorCaseTests,
    );

    return {
      modifiedUnchangedTests,
      newUntestedExports,
      missingErrorCaseTests,
      testSuggestions,
      contextString: buildContextString({
        modifiedUnchangedTests,
        newUntestedExports,
        missingErrorCaseTests,
        testSuggestions,
        contextString: '',
      }),
    };
  }

  /**
   * Memoized `findTestFile` lookup keyed by source path, so the (up to twelve
   * `fs.existsSync` calls per source file) mapping runs at most once per file
   * per analyze pass.
   * @param sourceFilePath - Repo-relative source file path.
   * @param workDir - Repository working directory.
   * @returns The mapped test file path, or `null` when none exists.
   */
  private findTestFileCached(sourceFilePath: string, workDir: string): string | null {
    if (this.testFileCache.has(sourceFilePath)) return this.testFileCache.get(sourceFilePath)!;
    const testFile = findTestFile(sourceFilePath, workDir);
    this.testFileCache.set(sourceFilePath, testFile);
    return testFile;
  }

  /**
   * Memoized test-file content read keyed by test file path. Missing or
   * unreadable files yield `null` without throwing.
   * @param testFile - Repo-relative test file path.
   * @param workDir - Repository working directory.
   * @returns The test file content, or `null` when unreadable.
   */
  private readTestFileCached(testFile: string, workDir: string): string | null {
    if (this.testContentCache.has(testFile)) return this.testContentCache.get(testFile)!;
    let content: string | null = null;
    try {
      content = fs.readFileSync(path.join(workDir, testFile), 'utf-8');
    } catch {
      content = null;
    }
    this.testContentCache.set(testFile, content);
    return content;
  }

  /**
   * Flag modified source symbols whose mapped test file exists but was NOT
   * updated in the same PR.
   * @param modifiedSymbols - Symbols touched by the PR.
   * @param changedTestFiles - Set of test file paths also changed in the PR.
   * @param workDir - Repository working directory.
   * @returns Gaps for modified symbols with unchanged test files.
   */
  detectModifiedUnchangedTests(
    modifiedSymbols: SourceSymbol[],
    changedTestFiles: Set<string>,
    workDir: string,
  ): TestGapEntry[] {
    const gaps: TestGapEntry[] = [];
    for (const symbol of modifiedSymbols) {
      if (!TESTABLE_KINDS.has(symbol.kind)) continue;
      const testFile = this.findTestFileCached(symbol.file, workDir);
      if (testFile !== null && !changedTestFiles.has(testFile)) {
        gaps.push({
          sourceFile: symbol.file,
          symbolName: symbol.name,
          testFile,
          reason: `Symbol \`${symbol.name}\` was modified but its test file \`${testFile}\` was not updated in this PR.`,
        });
      }
    }
    return gaps;
  }

  /**
   * Flag newly introduced exports that have no test coverage.
   * @param newSymbols - Symbols newly introduced by the PR.
   * @param changedTestFiles - Set of test file paths also changed in the PR.
   * @param workDir - Repository working directory.
   * @returns Gaps for new exports lacking tests.
   */
  detectNewUntestedExports(
    newSymbols: SourceSymbol[],
    changedTestFiles: Set<string>,
    workDir: string,
  ): TestGapEntry[] {
    const gaps: TestGapEntry[] = [];
    for (const symbol of newSymbols) {
      if (!TESTABLE_KINDS.has(symbol.kind)) continue;
      const testFile = this.findTestFileCached(symbol.file, workDir);
      if (testFile === null || !changedTestFiles.has(testFile)) {
        gaps.push({
          sourceFile: symbol.file,
          symbolName: symbol.name,
          testFile: testFile ?? undefined,
          reason:
            testFile === null
              ? `New export \`${symbol.name}\` has no test file covering it.`
              : `New export \`${symbol.name}\` is not covered by \`${testFile}\` (unchanged in this PR).`,
        });
      }
    }
    return gaps;
  }

  /**
   * Flag symbols with error-handling paths whose test file lacks error-case
   * assertions.
   * @param symbols - Symbols to inspect (modified + new).
   * @param workDir - Repository working directory.
   * @returns Gaps for symbols missing error-case tests.
   */
  detectErrorHandlingGaps(symbols: SourceSymbol[], workDir: string): TestGapEntry[] {
    const gaps: TestGapEntry[] = [];
    for (const symbol of symbols) {
      if (!symbol.hasErrorHandling) continue;
      const testFile = this.findTestFileCached(symbol.file, workDir);
      if (testFile === null) continue;
      const testContent = this.readTestFileCached(testFile, workDir);
      if (testContent === null) continue;
      const hasErrorAssertions = TEST_ERROR_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(testContent);
      });
      if (!hasErrorAssertions) {
        gaps.push({
          sourceFile: symbol.file,
          symbolName: symbol.name,
          testFile,
          errorPaths: symbol.errorPaths ?? ['throw'],
          reason: `Symbol \`${symbol.name}\` has error-handling paths but \`${testFile}\` contains no error-case assertions (e.g. \`.rejects\`, \`toThrow\`).`,
        });
      }
    }
    return gaps;
  }

  /**
   * Derive test suggestions from the detected gaps.
   * @param modifiedUnchangedTests - Gaps for modified symbols with unchanged tests.
   * @param newUntestedExports - Gaps for new exports without coverage.
   * @param missingErrorCaseTests - Gaps for error paths lacking error-case tests.
   * @returns The derived test suggestions.
   */
  buildSuggestions(
    modifiedUnchangedTests: TestGapEntry[],
    newUntestedExports: TestGapEntry[],
    missingErrorCaseTests: TestGapEntry[],
  ): TestSuggestion[] {
    const suggestions: TestSuggestion[] = [];
    for (const gap of modifiedUnchangedTests) {
      suggestions.push({
        sourceFile: gap.sourceFile,
        symbolName: gap.symbolName,
        suggestedTestPath: gap.testFile ?? suggestTestPath(gap.sourceFile),
        suggestionType: 'update-test',
      });
    }
    for (const gap of newUntestedExports) {
      suggestions.push({
        sourceFile: gap.sourceFile,
        symbolName: gap.symbolName,
        suggestedTestPath: gap.testFile ?? suggestTestPath(gap.sourceFile),
        suggestionType: 'missing-test',
      });
    }
    for (const gap of missingErrorCaseTests) {
      suggestions.push({
        sourceFile: gap.sourceFile,
        symbolName: gap.symbolName,
        suggestedTestPath: gap.testFile ?? suggestTestPath(gap.sourceFile),
        suggestionType: 'error-case',
      });
    }
    return suggestions;
  }
}

/**
 * Format a test-gap result as markdown for prompt injection. Returns an empty
 * string when no gaps were found.
 * @param result - The structured gap result.
 * @returns The formatted markdown context string.
 */
export function buildContextString(result: TestGapResult): string {
  const sections: string[] = [];

  if (result.modifiedUnchangedTests.length > 0) {
    sections.push('**Modified without test updates:**');
    for (const gap of result.modifiedUnchangedTests) {
      sections.push(
        `- ${gap.sourceFile}: \`${gap.symbolName}\` (test file \`${gap.testFile ?? 'missing'}\` not updated)`,
      );
    }
  }

  if (result.newUntestedExports.length > 0) {
    sections.push('**New exports without test coverage:**');
    for (const gap of result.newUntestedExports) {
      sections.push(`- ${gap.sourceFile}: \`${gap.symbolName}\``);
    }
  }

  if (result.missingErrorCaseTests.length > 0) {
    sections.push('**Missing error-case tests:**');
    for (const gap of result.missingErrorCaseTests) {
      sections.push(
        `- ${gap.sourceFile}: \`${gap.symbolName}\` (error paths: ${(gap.errorPaths ?? []).join(', ')})`,
      );
    }
  }

  if (result.testSuggestions.length > 0) {
    sections.push('**Suggested tests:**');
    for (const suggestion of result.testSuggestions) {
      sections.push(
        `- \`${suggestion.suggestedTestPath}\` → cover \`${suggestion.symbolName}\` (${suggestion.suggestionType.replaceAll('-', ' ')})`,
      );
    }
  }

  return sections.join('\n');
}
