import type { ChangedFile } from '../types/index.js';
import { escapeInlineCode, sanitizeMarkdown } from './markdown.js';

/** Weight applied per churned line when scoring a function. */
export const CHURN_WEIGHT = 2;
/** Penalty applied per nesting-depth level when scoring a function. */
export const NESTING_WEIGHT = 5;
/** Flat penalty added when a function has no covering test (test gap). */
export const TEST_GAP_PENALTY = 15;
/** Maximum number of function rows rendered in the score table. */
export const MAX_FUNCTION_SCORE_ROWS = 10;

/**
 * Static inputs describing one changed function. All inputs are locally
 * computed — no model call is involved.
 */
export interface FunctionScoreInput {
  /** Repo-relative file path. */
  file: string;
  /** Function or symbol name. */
  name: string;
  /** 1-based line where the function starts. */
  line: number;
  /** Number of added/changed lines attributed to the function. */
  churnLines: number;
  /** Best-effort nesting depth signal (0 when unknown). */
  nestingDepth?: number;
  /** Whether the function lacks covering tests. */
  hasTestGap: boolean;
}

/** A scored function. Higher `score` means riskier (0-100). */
export interface FunctionScore extends FunctionScoreInput {
  /** Deterministic risk score, clamped to 0-100. */
  score: number;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Normalize a numeric signal to a finite non-negative value (0 when unknown).
 * @param value - Raw signal value from diff metadata.
 * @returns Finite non-negative number, or 0 when the input is not a number.
 */
function normalizeSignal(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * True when the entry already carries a finite pre-computed score.
 * @param entry - Raw input or already-scored function entry.
 * @returns True when the entry is a scored function.
 */
function isScored(entry: FunctionScoreInput | FunctionScore): entry is FunctionScore {
  return (
    typeof (entry as FunctionScore).score === 'number' &&
    Number.isFinite((entry as FunctionScore).score)
  );
}

/**
 * Canonical riskiest-first ordering: score descending, ties broken by file
 * then name so equal-score rows render deterministically.
 * @param a - First scored function.
 * @param b - Second scored function.
 * @returns Negative when `a` sorts first, positive when `b` sorts first.
 */
function compareFunctionScores(a: FunctionScore, b: FunctionScore): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Compute a deterministic 0-100 risk score per function from static inputs
 * only: `score = clamp(churnLines * CHURN_WEIGHT + nesting * NESTING_WEIGHT
 * + (hasTestGap ? TEST_GAP_PENALTY : 0))`.
 * Results are sorted descending by score (ties broken by file, then name).
 * @param inputs - Changed-function inputs.
 * @returns Scored functions sorted riskiest-first.
 */
export function computeFunctionScores(inputs: FunctionScoreInput[]): FunctionScore[] {
  if (!inputs || inputs.length === 0) return [];
  const scored: FunctionScore[] = inputs.map((input) => {
    const churn = normalizeSignal(input.churnLines);
    const nesting = normalizeSignal(input.nestingDepth);
    const score = clampScore(
      churn * CHURN_WEIGHT + nesting * NESTING_WEIGHT + (input.hasTestGap ? TEST_GAP_PENALTY : 0),
    );
    return { ...input, churnLines: churn, nestingDepth: nesting, score };
  });
  scored.sort(compareFunctionScores);
  return scored;
}

/**
 * Escape a value for interpolation inside a backtick markdown table cell.
 * Backslashes are escaped first so a trailing backslash cannot escape the
 * closing backtick; then the shared inline-code escaping applies.
 * @param value - Raw value from diff/symbol metadata.
 * @returns Escaped cell text (without surrounding backticks).
 */
function escapeTableCell(value: unknown): string {
  const escaped = escapeInlineCode(String(value ?? '').replace(/\\/g, '\\\\'));
  return escaped.replace(/\|/g, '\\|');
}

/**
 * Render scored functions as a compact markdown table (max 10 rows) with a
 * heuristic disclaimer. Returns '' when there are no scores.
 * @param scores - Pre-scored functions (scored or raw inputs).
 * @returns Markdown table string, or '' when empty.
 */
export function buildFunctionScoreTable(
  scores: ReadonlyArray<FunctionScore | FunctionScoreInput>,
): string {
  if (!scores || scores.length === 0) return '';
  const resolved: FunctionScore[] = scores.every(isScored)
    ? [...(scores as FunctionScore[])]
    : computeFunctionScores(scores as FunctionScoreInput[]);
  if (resolved.length === 0) return '';
  const top = [...resolved].sort(compareFunctionScores).slice(0, MAX_FUNCTION_SCORE_ROWS);
  if (top.length === 0) return '';
  const lines: string[] = [
    '### Function Quality Scores',
    '',
    '| Function | File | Score |',
    '|----------|------|-------|',
  ];
  for (const s of top) {
    const fn = escapeTableCell(s.name);
    const file = escapeTableCell(s.file);
    const line = Number.isInteger(s.line) && (s.line as number) > 0 ? (s.line as number) : 1;
    lines.push(`| \`${fn}\` | \`${file}:${line}\` | ${clampScore(s.score)} |`);
  }
  lines.push('');
  lines.push(
    `*${sanitizeMarkdown('Scores are heuristic static signals (churn + nesting + test-gap), not verdicts.')}*`,
  );
  return lines.join('\n');
}

const HUNK_HEADER_RE = /^@@\s+-[0-9]+(?:,[0-9]+)?\s+\+([0-9]+)(?:,[0-9]+)?\s+@@(?:\s+(.*))?$/;
// Matches common test-file conventions: __tests__/Test/Tests/Spec path
// segments, .test./.spec. infixes (foo.test.ts), and _test/test_/-test affixes
// (foo_test.go, test_foo.py, foo-test.ts).
const TEST_PATH_RE =
  /(?:^|\/)(?:__tests__|[Tt]est|[Tt]ests|[Ss]pec)(?:\/|$)|[.](?:test|spec)[.]|[_-]test(?=$|[./])|(?:^|\/)test[_-]/;

/**
 * Whether a changed file looks like a test file.
 * @param filePath - Repository-relative file path.
 * @returns True when the path matches common test-file conventions.
 */
function isTestFile(filePath: string): boolean {
  return TEST_PATH_RE.test(filePath);
}

/**
 * Whether a changed file looks like reviewable source (not docs/config).
 * @param filePath - Repository-relative file path.
 * @returns True when the path has a recognized source-code extension.
 */
function isSourceFile(filePath: string): boolean {
  if (isTestFile(filePath)) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt|scala|c|cc|cpp|h|hpp)$/.test(
    filePath,
  );
}

/**
 * Estimate nesting depth from the indentation of added lines: the deepest
 * leading indent (tabs count as 2 spaces) halved, a cheap deterministic
 * proxy for block nesting without parsing. Assumes 2-space indentation, so
 * 4-space-indented repos report roughly double the true depth; the score only
 * uses this as a relative static signal.
 * @param addedLines - Raw added diff lines for the function.
 * @returns Estimated nesting depth (non-negative integer).
 */
function estimateNesting(addedLines: string[]): number {
  let maxIndent = 0;
  for (const content of addedLines) {
    const match = content.match(/^[ \t]+/);
    if (!match) continue;
    let width = 0;
    for (const ch of match[0]) width += ch === '\t' ? 2 : 1;
    if (width > maxIndent) maxIndent = width;
  }
  return Math.floor(maxIndent / 2);
}

/**
 * Collect deterministic per-function score inputs from a PR's changed files.
 * Each diff hunk with added lines becomes one row: the hunk header's trailing
 * function context (or the file basename when absent) names the row,
 * added-line count is the churn signal, indentation of added lines estimates
 * nesting, and a source file is treated as a test gap when no test file is
 * among the changed files. The test-gap signal is a coarse repo-wide
 * heuristic — an unrelated test change clears the gap for all source files;
 * per-file/test-target correlation is intentionally out of scope.
 * Only reviewable source files (by extension, excluding test files) produce
 * rows: docs/config/test-only and deletion-only hunks (zero added lines) are
 * skipped, so docs-only or deletion-only PRs yield no table.
 * Pure and dependency-free — no model call, no I/O.
 * @param changedFiles - Changed files from the PR context.
 * @returns Score inputs in diff order (scoring/sorting happens downstream).
 */
export function collectFunctionScoreInputs(
  changedFiles: ChangedFile[] | undefined,
): FunctionScoreInput[] {
  if (!changedFiles || changedFiles.length === 0) return [];
  const hasTestChange = changedFiles.some((f) => isTestFile(f.path));
  const inputs: FunctionScoreInput[] = [];
  for (const file of changedFiles) {
    if (!file || file.status === 'removed' || !file.patch) continue;
    // Skip non-source hunks (docs, config, test files): scoring them would
    // render misleading rows on docs-only or test-only PRs.
    if (!isSourceFile(file.path)) continue;
    const fallbackName = file.path.split('/').pop() || file.path;
    let hunkName: string | null = null;
    let hunkLine = 0;
    let added: string[] = [];
    const flush = (): void => {
      // Skip deletion-only hunks: zero added lines carry no churn signal and
      // would otherwise emit zero-churn rows.
      if (added.length === 0) return;
      inputs.push({
        file: file.path,
        name: hunkName?.trim() ? hunkName.trim().slice(0, 120) : fallbackName,
        line: hunkLine > 0 ? hunkLine : 1,
        churnLines: added.length,
        nestingDepth: estimateNesting(added),
        hasTestGap: isSourceFile(file.path) && !hasTestChange,
      });
      added = [];
    };
    for (const raw of file.patch.split('\n')) {
      const line = raw.replace(/\r$/, '');
      const header = HUNK_HEADER_RE.exec(line);
      if (header) {
        flush();
        hunkLine = Number(header[1]) || 1;
        hunkName = header[2] ?? null;
        continue;
      }
      if (hunkLine === 0) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added.push(line.slice(1));
      }
    }
    flush();
  }
  return inputs;
}

/**
 * Build the trailing options bag for `postReview`/`buildReviewBody` from the
 * review config flag and the PR's changed files. Returns `undefined` when the
 * flag is off so callers can pass the result straight through.
 * @param showFunctionScores - Config flag (`review.showFunctionScores`).
 * @param changedFiles - Changed files from the PR context.
 * @returns Options bag with collected inputs, or `undefined` when disabled.
 */
export function buildFunctionScoreOptions(
  showFunctionScores: boolean | undefined,
  changedFiles: ChangedFile[] | undefined,
): { showFunctionScores: true; functionScores: FunctionScoreInput[] } | undefined {
  if (showFunctionScores !== true) return undefined;
  return { showFunctionScores: true, functionScores: collectFunctionScoreInputs(changedFiles) };
}
