/**
 * Jev diff-risk/budget gate (Module 3).
 *
 * When `JEV_ENABLED=true`, the PR diff (stat + file list + description) is
 * scored with one Jev batch per PR (two `noul` + one `score` question, a
 * single HTTP call — no per-file fan-out) and the verdict adjusts the
 * existing budget/effort selection before the expensive fan-out.
 *
 * Exact mapping onto the modes the existing code already supports
 * (`ReviewBudgetMode`: `full` | `summary` | `split`, selected
 * deterministically by `determineBudgetMode` from diff size):
 *
 * | Deterministic mode | Jev risk (confident) | Result |
 * | ------------------ | -------------------- | ------ |
 * | `summary` / `split` | `high` (auth/migration/secrets touch, destructive migration, or blast-radius > 0.7) | ESCALATE to `full` (fuller review) |
 * | `full` | `high` | `full` (unchanged — already the fullest mode) |
 * | any | `unknown` (disabled, unavailable, or below `JEV_CONFIDENCE_FLOOR`) | deterministic mode unchanged (fail-open) |
 * | any | `low` without deterministic docs-only | deterministic mode unchanged, no suggestion |
 * | any | `low` with deterministic docs-only | deterministic mode unchanged + advisory `suggestLite: true` |
 *
 * Never-invent-a-bypass invariants (enforced by `resolveJevBudgetMode`):
 * - Jev can only ESCALATE toward `full`. Jev never selects `summary` or
 *   `split` on its own — only the deterministic size gate may reduce depth.
 * - Jev never skips review. `suggestLite` is advisory only (logged and
 *   returned for operators/future effort selection): the review still runs at
 *   the deterministic mode. It is set only when the DETERMINISTIC docs-only
 *   check (`isDocsOnlyPaths`) already holds — Jev low-risk alone is never
 *   sufficient.
 * - Critical-risk signals never suppress review: `high` forces `full` and
 *   clears `suggestLite`.
 * - `review.effort` (`lite` / `balanced`) stays a workflow/config opt-in;
 *   this gate does not select effort presets itself.
 *
 * Fail-open contract (fail-open for genuine failures; caller cancellation
 * rejects so aborts propagate):
 * - `JEV_ENABLED!=true` → deterministic mode unchanged, no HTTP traffic.
 * - No API key / transport / API / parse failure / low confidence →
 *   deterministic mode unchanged (`skipped: true`).
 * - Incremental (delta) reviews skip the gate: budget adaptation is already
 *   skipped for them deterministically (they always run `full`), so
 *   escalation would be a no-op (enforced by the engine caller).
 *
 * Bounded: at most one Jev batch per PR (≤3 questions, one call), reusing
 * Module 1's batching cap (≤20), timeouts, circuit breaker, strict parsing,
 * and AbortSignal conventions via `RestJevDiffRiskProvider`.
 *
 * External-sharing note: the diff stat, file list, and PR description cross
 * the repo boundary to the external Jev endpoint when enabled
 * (secret-shaped text redacted pre-send via sanitize-before-truncate — see
 * `buildDiffRiskContext`). User-facing disclosure lives in the README
 * Configuration Reference (`jev_enabled` row) and `action.yml`.
 */

import type { ReviewBudgetMode } from '../types/index.js';
import {
  JEV_UNAVAILABLE_REASON,
  type JevCallOptions,
  type JevDiffRiskAssessment,
  type JevDiffRiskLevel,
  type JevDiffRiskProvider,
  RestJevDiffRiskProvider,
  isJevCancelError,
  isJevEnabled,
} from '../utils/jev-client.js';
import { Logger } from '../utils/logger.js';

/** Basename roots treated as documentation for the deterministic docs-only check. */
const DOCS_ONLY_BASENAME_ROOTS: ReadonlySet<string> = new Set([
  'authors',
  'changelog',
  'changes',
  'codeowners',
  'contributing',
  'contributors',
  'licence',
  'license',
  'notice',
  'notices',
  'readme',
]);

/**
 * Upper bound (ms) for the diff-risk gate's per-attempt Jev timeout. The
 * gate sits on the review critical path, so the engine caps its timeout at
 * this value — well below the generic `JEV_TIMEOUT_MS` ceiling (up to 10s
 * per attempt × a retry ≈ 20s+) — so a slow Jev endpoint cannot stall
 * reviews. Consumed by the engine call site via
 * `Math.min(resolveJevTimeoutMs(), JEV_DIFF_RISK_GATE_TIMEOUT_CAP_MS)`.
 */
export const JEV_DIFF_RISK_GATE_TIMEOUT_CAP_MS = 2000;

/** Input to the diff-risk gate (deterministic mode + PR diff summary). */
export interface DiffRiskGateInput {
  /** Budget mode selected by the deterministic size gate. */
  deterministic: ReviewBudgetMode;
  /** Total diff lines across the review-scoped changed files. */
  totalDiffLines: number;
  /** Repo-relative paths of the review-scoped changed files. */
  filePaths: string[];
  /** PR title (sent as part of the description). */
  title?: string;
  /** PR body (sent as part of the description). */
  body?: string;
}

/** Options accepted by {@link assessJevDiffRiskGate}. */
export interface DiffRiskGateOptions {
  /** Logger for diagnostics (defaults to a module logger). */
  logger?: Logger;
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout override (ms). */
  timeoutMs?: number;
  /** Model override (defaults to `JEV_MODEL` / free tier). */
  model?: string;
  /** Optional AbortSignal to cancel the Jev batch mid-flight. */
  signal?: AbortSignal;
  /**
   * Risk provider override (tests / future SDK plug-in). Defaults to the
   * shared REST provider; the engine never passes one today.
   */
  provider?: JevDiffRiskProvider;
}

/** Outcome of the diff-risk gate (budget mode + advisory lite suggestion). */
export interface DiffRiskGateResult {
  /** Effective budget mode (deterministic, or `full` after escalation). */
  budgetMode: ReviewBudgetMode;
  /**
   * Advisory lite suggestion: true only when Jev reports confident `low`
   * risk AND the deterministic docs-only check holds. Never skips or
   * reduces review on its own — the review still runs at `budgetMode`, and
   * the engine logs the suggestion (debug) without consuming it. The
   * docs-only check is intentionally narrow (see `isDocsOnlyPaths`): only
   * the repo-top-level `docs/` tree, markdown/rST files, and well-known
   * doc basenames (README, LICENSE, NOTICE, CHANGELOG, …) count — source
   * under nested `*\/docs\/*` paths and generic `.txt` files do not.
   */
  suggestLite: boolean;
  /** Jev risk level (`unknown` whenever Jev could not answer). */
  level: JevDiffRiskLevel;
  /** Machine-readable reason (`ok`, `jev-disabled`, `jev-unavailable`). */
  reason: string;
  /** Model version echoed by the API, when a call succeeded. */
  model?: string;
  /** True when Jev contributed nothing (disabled/unavailable). */
  skipped: boolean;
}

const moduleLogger = new Logger('jev-diff-risk');

/** Shared REST provider used when callers do not inject their own. */
const defaultDiffRiskProvider = new RestJevDiffRiskProvider();

/**
 * Check whether a single path is documentation-only: under the
 * repo-top-level `docs/` tree, a markdown/rST file, or a well-known doc
 * basename (LICENSE, NOTICE, CHANGELOG, README, …). Matching is
 * case-insensitive. Deliberately narrow: nested `*\/docs\/*` paths (e.g.
 * `src/docs/code.ts`) are treated as source, not docs, and generic `.txt`
 * files (seed/data `.txt`) do NOT count — doc-ish `.txt` names
 * (`NOTICE.txt`, …) still match via the well-known basename roots.
 *
 * @param filePath - Repo-relative file path.
 * @returns True when the path counts as documentation-only.
 */
function isDocsOnlyPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return false;
  const lower = filePath.toLowerCase();
  if (lower === 'docs' || lower.startsWith('docs/')) return true;
  if (/\.(md|mdx|markdown|rst)$/.test(lower)) return true;
  const base = lower.split('/').pop() ?? lower;
  if (DOCS_ONLY_BASENAME_ROOTS.has(base)) return true;
  const dot = base.lastIndexOf('.');
  const root = dot > 0 ? base.slice(0, dot) : base;
  return DOCS_ONLY_BASENAME_ROOTS.has(root);
}

/**
 * Deterministic docs-only check: true only when the PR touches at least one
 * file and EVERY path is documentation-only (see `isDocsOnlyPath`). An empty
 * or non-array list is never docs-only — the zero-file early-returns own
 * that case, and this gate must not opine on it.
 *
 * @param paths - Repo-relative changed-file paths.
 * @returns True when every path is documentation-only.
 */
export function isDocsOnlyPaths(paths: string[]): boolean {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  return paths.every(isDocsOnlyPath);
}

/**
 * Pure budget-mode mapping for a Jev risk level. Escalation-only: `high`
 * forces `full`; `low` may only set the advisory `suggestLite` flag (and
 * only when the deterministic docs-only check already holds); `unknown`
 * leaves everything unchanged. Never selects `summary`/`split`, never
 * skips review.
 *
 * @param deterministic - Budget mode selected by the deterministic size gate.
 * @param level - Jev risk level (`unknown` = fail-open).
 * @param docsOnly - Result of the deterministic docs-only check.
 * @returns The effective budget mode plus the advisory lite suggestion.
 */
export function resolveJevBudgetMode(
  deterministic: ReviewBudgetMode,
  level: JevDiffRiskLevel,
  docsOnly: boolean,
): { budgetMode: ReviewBudgetMode; suggestLite: boolean } {
  if (level === 'high') return { budgetMode: 'full', suggestLite: false };
  if (level === 'low' && docsOnly === true) {
    return { budgetMode: deterministic, suggestLite: true };
  }
  return { budgetMode: deterministic, suggestLite: false };
}

/**
 * Run the Jev diff-risk/budget gate: score the PR diff with a single Jev
 * batch and map the verdict onto the deterministic budget mode (see
 * {@link resolveJevBudgetMode}). Fail-open except caller cancellation:
 * disabled/unavailable/low-confidence Jev returns the deterministic mode
 * unchanged, but an aborted signal rejects so cancellation propagates.
 *
 * @param input - Deterministic mode plus the PR diff summary (stat inputs, file paths, title/body).
 * @param options - Gate options (logger/fetch/model/timeout/signal/provider overrides).
 * @returns The effective budget mode, advisory lite flag, and risk metadata. Rejects only on caller cancellation.
 */
export async function assessJevDiffRiskGate(
  input: DiffRiskGateInput,
  options: DiffRiskGateOptions = {},
): Promise<DiffRiskGateResult> {
  const logger = options.logger ?? moduleLogger;
  try {
    const deterministic: ReviewBudgetMode =
      input?.deterministic === 'summary' || input?.deterministic === 'split'
        ? input.deterministic
        : 'full';
    if (!isJevEnabled()) {
      return {
        budgetMode: deterministic,
        suggestLite: false,
        level: 'unknown',
        reason: 'jev-disabled',
        skipped: true,
      };
    }
    const rawPaths = Array.isArray(input?.filePaths) ? input.filePaths : [];
    const filePaths = rawPaths.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
    const totalDiffLines =
      Number.isFinite(input?.totalDiffLines) && (input?.totalDiffLines ?? 0) >= 0
        ? Math.floor(input.totalDiffLines)
        : 0;
    const title = typeof input?.title === 'string' ? input.title : '';
    const body = typeof input?.body === 'string' ? input.body : '';
    const provider = options.provider ?? defaultDiffRiskProvider;
    const callOptions: JevCallOptions = {
      logger,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      model: options.model,
      signal: options.signal,
    };
    const assessment: JevDiffRiskAssessment = await provider.assessRisk(
      {
        statLine: `${filePaths.length} file(s) changed, ~${totalDiffLines} diff lines`,
        filePaths,
        description: `${title}\n${body}`.trim(),
      },
      callOptions,
    );
    // A swallowing provider may resolve despite cancellation — re-check the
    // signal so a cancelled call rejects instead of resolving fail-open.
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException('Jev diff-risk gate aborted', 'AbortError');
    }
    const docsOnly = isDocsOnlyPaths(filePaths);
    const mapped = resolveJevBudgetMode(deterministic, assessment.level, docsOnly);
    if (mapped.budgetMode !== deterministic) {
      logger.info(
        `Jev diff-risk gate escalated budget mode ${deterministic} → ${mapped.budgetMode} ` +
          `(risk=${assessment.level}, reason=${assessment.reason})`,
      );
    } else if (mapped.suggestLite) {
      logger.info(
        `Jev diff-risk gate suggests lite review (docs-only, risk=${assessment.level}) — ` +
          `advisory only, review proceeds as ${deterministic}`,
      );
    }
    return {
      budgetMode: mapped.budgetMode,
      suggestLite: mapped.suggestLite,
      level: assessment.level,
      reason: assessment.reason,
      model: assessment.model,
      skipped: assessment.unavailable,
    };
  } catch (err) {
    if (options.signal?.aborted || isJevCancelError(err)) {
      // Caller cancellation is not a gate failure: reject (preserving the
      // signal's Error reason, or an AbortError otherwise) so the review
      // pipeline observes cancellation instead of a fail-open resolve.
      // The `isJevCancelError` disjunct covers providers that surface an
      // abort without the gate-level signal (mirrors the Module 1/2
      // provider catches). Genuine Jev/timeout failures with a live
      // signal still fail open below — timeouts surface as `TimeoutError`,
      // never `AbortError`.
      throw err instanceof Error
        ? err
        : new DOMException('Jev diff-risk gate aborted', 'AbortError');
    }
    logger.warn(
      `Jev diff-risk gate failed (fail-open, keeping deterministic mode): ${err instanceof Error ? err.message : String(err)}`,
    );
    const deterministic: ReviewBudgetMode =
      input?.deterministic === 'summary' || input?.deterministic === 'split'
        ? input.deterministic
        : 'full';
    return {
      budgetMode: deterministic,
      suggestLite: false,
      level: 'unknown',
      reason: JEV_UNAVAILABLE_REASON,
      skipped: true,
    };
  }
}
