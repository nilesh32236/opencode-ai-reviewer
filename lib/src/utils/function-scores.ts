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
 * Compute a deterministic 0-100 risk score per function from static inputs
 * only: `score = clamp(churnLines * CHURN_WEIGHT + nesting * NESTING_WEIGHT
 * + (hasTestGap ? TEST_GAP_PENALTY : 0))`.
 * Results are sorted descending by score (ties broken by file, then name).
 * @param inputs - Changed-function inputs.
 * @returns Scored functions sorted riskiest-first.
 */
export function computeFunctionScores(inputs: FunctionScoreInput[]): FunctionScore[] {
  const scored: FunctionScore[] = (inputs ?? []).map((input) => {
    const churn = Math.max(0, input.churnLines ?? 0);
    const nesting = Math.max(0, input.nestingDepth ?? 0);
    const score = clampScore(
      churn * CHURN_WEIGHT + nesting * NESTING_WEIGHT + (input.hasTestGap ? TEST_GAP_PENALTY : 0),
    );
    return { ...input, churnLines: churn, nestingDepth: nesting, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return scored;
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
  const resolved: FunctionScore[] = scores.every(
    (s) => typeof (s as FunctionScore).score === 'number',
  )
    ? ([...scores] as FunctionScore[])
    : computeFunctionScores(scores as FunctionScoreInput[]);
  if (resolved.length === 0) return '';
  const top = [...resolved].sort((a, b) => b.score - a.score).slice(0, MAX_FUNCTION_SCORE_ROWS);
  if (top.length === 0) return '';
  const lines: string[] = [
    '### Function Quality Scores',
    '',
    '| Function | File | Score |',
    '|----------|------|-------|',
  ];
  for (const s of top) {
    const fn = escapeInlineCode(s.name).replace(/\|/g, '\\|');
    const file = escapeInlineCode(s.file).replace(/\|/g, '\\|');
    lines.push(`| \`${fn}\` | \`${file}:${s.line}\` | ${clampScore(s.score)} |`);
  }
  lines.push('');
  lines.push(
    `*${sanitizeMarkdown('Scores are heuristic static signals (churn + nesting + test-gap), not verdicts.')}*`,
  );
  return lines.join('\n');
}
