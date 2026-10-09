/**
 * Coverage accounting for a review run.
 *
 * The problem this exists to solve: a review pass that cannot read its input
 * and a review pass that reads everything and finds nothing produce the same
 * observable result — `issues: []`. Nothing downstream can tell them apart, so
 * a failure to look is silently indistinguishable from a clean bill of health,
 * and the reviewer's own verdict cannot defend itself.
 *
 * Concretely, on run 37090355702 the audit secret pass enumerated 19 files,
 * failed to open every one, logged "skipped", and returned `[]`. The published
 * verdict carried no secret finding and no indication that the scanner had
 * never looked at anything.
 *
 * `CoverageLedger` is the mechanism that makes that state representable. Every
 * pass that can report zero findings records an entry — including when it
 * reports nothing because it could not run. The ledger then folds those
 * entries into a {@link ReviewTrust} block that rides along on the result and
 * into the rendered body, so the claim "nothing found" always arrives with the
 * claim "here is what was searched, and here is what was not".
 *
 * Recording is intentionally cheap and synchronous: it must be safe to call
 * from a `catch` block on the failure path, which is exactly where the
 * accounting matters most.
 */

import type { PassCoverage, PassOutcome, ReviewTrust } from '../types/index.js';

/** Reasons a pass reports, used to keep call sites honest about wording. */
export const PASS_SECRET_REVIEW = 'secrets.review';
export const PASS_SECRET_AUDIT = 'secrets.audit';
export const PASS_LINTERS = 'linters';
export const PASS_SCA = 'sca';
export const PASS_SHELL_VALIDATE = 'shell-validate';
export const PASS_META_VERIFICATION = 'meta-verification';
export const PASS_CODEBASE_INDEX = 'codebase-index';
export const PASS_REPO_RULES = 'repo-rules';
export const PASS_AGENTS_MD_HEAD = 'agents-md-head';
export const PASS_COMMIT_MESSAGES = 'commit-messages';
export const PASS_REPO_INSTRUCTIONS = 'repo-instructions';
export const PASS_TEST_GAP = 'test-gap';
export const PASS_BLAME = 'blame';
export const PASS_LEARNING_STORE = 'learning-store';

/**
 * Every pass that can end a review with zero findings.
 *
 * This registry is what stops a partial ledger from reading like a complete
 * one. A ledger only knows about passes someone remembered to record, so
 * "we looked here" and "we looked everywhere" are indistinguishable unless
 * something enumerates the full set independently and cross-checks it. That
 * something is this list: {@link buildReviewTrust} compares it against the
 * recorded entries and reports the difference as {@link ReviewTrust.uncovered}.
 *
 * Two properties matter:
 *
 *   - it is derived from the pipeline's structure, not from the ledger, so a
 *     pass that stops recording cannot quietly remove itself from view;
 *   - adding a pass that can report zero findings and forgetting to instrument
 *     it produces a visible `uncovered` entry rather than a clean verdict.
 *
 * The failure it guards is concrete: a ledger listing three passes reads as
 * thorough coverage of a pipeline that has fourteen.
 */
export const KNOWN_ZERO_FINDING_PASSES: readonly string[] = Object.freeze([
  PASS_SECRET_REVIEW,
  PASS_SECRET_AUDIT,
  PASS_LINTERS,
  PASS_SCA,
  PASS_META_VERIFICATION,
  PASS_SHELL_VALIDATE,
  PASS_CODEBASE_INDEX,
  PASS_REPO_RULES,
  PASS_AGENTS_MD_HEAD,
  PASS_COMMIT_MESSAGES,
  PASS_REPO_INSTRUCTIONS,
  PASS_TEST_GAP,
  PASS_BLAME,
  PASS_LEARNING_STORE,
]);

/**
 * Outcome a pass should report given how many inputs it read and whether it
 * found anything.
 *
 * The unreadable case is the whole point: it takes precedence over `clean` so
 * that a pass which both scanned some files and failed on others can never be
 * summarised as clean. A gap in coverage outranks the absence of findings,
 * because "I found nothing" is not true of the inputs I never opened.
 *
 * @param scanned - Inputs actually read and analysed.
 * @param unreadable - Inputs enumerated but not readable.
 * @param findings - Findings reported across the inputs read.
 * @returns The outcome the pass should report for this combination.
 */
export function deriveOutcome(scanned: number, unreadable: number, findings: number): PassOutcome {
  if (unreadable > 0) return 'unreadable';
  if (scanned === 0) return 'skipped';
  return findings > 0 ? 'findings' : 'clean';
}

/**
 * Collects {@link PassCoverage} entries for one review run.
 *
 * Not thread-safe by design: it is owned by a single engine run. Recording is
 * keyed by pass name and the last recording for a name wins, so a pass that is
 * invoked more than once in a run (linters, for instance) reports its final
 * aggregate rather than every intermediate attempt.
 */
export class CoverageLedger {
  private readonly entries = new Map<string, PassCoverage>();

  /**
   * Record how a pass ended.
   *
   * @param pass - Stable pass identifier.
   * @param outcome - How the pass ended; prefer {@link deriveOutcome} so the
   *   unreadable case cannot be forgotten.
   * @param scanned - Inputs actually read and analysed.
   * @param unreadable - Inputs enumerated but not readable.
   * @param reason - Why, when the outcome is not `clean`/`findings`.
   */
  record(
    pass: string,
    outcome: PassOutcome,
    scanned: number,
    unreadable = 0,
    reason?: string,
  ): void {
    this.entries.set(pass, {
      pass,
      outcome,
      scanned,
      unreadable,
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Record a pass from raw counts, deriving the outcome.
   *
   * @param pass - Stable pass identifier.
   * @param scanned - Inputs actually read and analysed.
   * @param unreadable - Inputs enumerated but not readable.
   * @param findings - Findings produced, when known.
   * @param reason - Why the pass could not read its inputs, when it could not.
   */
  recordCounts(
    pass: string,
    scanned: number,
    unreadable: number,
    findings: number,
    reason?: string,
  ): void {
    this.record(pass, deriveOutcome(scanned, unreadable, findings), scanned, unreadable, reason);
  }

  /**
   * Look up one pass's entry.
   *
   * @param pass - Stable pass identifier.
   * @returns The recorded entry, or undefined when the pass never ran.
   */
  get(pass: string): PassCoverage | undefined {
    return this.entries.get(pass);
  }

  /**
   * Record the linter pass from its results.
   *
   * `runLinters` returns `[]` for four materially different situations — no
   * linters configured, every linter skipped, every linter crashed, and every
   * linter ran clean — and a caller that only sees the array cannot tell them
   * apart. This collapses the array back into the specific claim, so "no lint
   * findings" can never be reported by a run in which no linter actually ran.
   *
   * @param results - Per-linter results. Entries that were skipped upstream
   *   never reach this list, so its length is the number that actually ran.
   */
  recordLinterOutcome(results: Array<{ success: boolean; findings: unknown[] }>): void {
    const ran = results.length;
    const failed = results.filter((r) => !r.success).length;
    const findings = results.reduce((sum, r) => sum + r.findings.length, 0);

    if (ran === 0) {
      this.record(PASS_LINTERS, 'skipped', 0, 0, 'no linter produced a result');
      return;
    }
    if (failed === ran) {
      this.record(PASS_LINTERS, 'failed', ran, 0, `all ${ran} configured linter(s) failed`);
      return;
    }
    if (failed > 0) {
      // Partial coverage. Recorded as failed rather than clean so a
      // clean-looking linter section cannot hide that it did not see
      // everything the operator configured.
      this.record(
        PASS_LINTERS,
        'failed',
        ran - failed,
        failed,
        `${failed} of ${ran} configured linter(s) failed`,
      );
      return;
    }
    this.recordCounts(PASS_LINTERS, ran, 0, findings);
  }

  /**
   * Every recorded entry, in insertion order.
   * @returns The recorded entries, in insertion order.
   */
  list(): PassCoverage[] {
    return [...this.entries.values()];
  }

  /**
   * True when no recorded pass is `unreadable` or `failed`.
   * @returns True when every recorded pass completed without a coverage gap.
   */
  isComplete(): boolean {
    return this.list().every(
      (e) => e.outcome === 'clean' || e.outcome === 'findings' || e.outcome === 'skipped',
    );
  }

  /**
   * Total inputs across all passes that could not be read.
   * @returns The summed unreadable-input count across all recorded passes.
   */
  unreadableTotal(): number {
    return this.list().reduce((sum, e) => sum + e.unreadable, 0);
  }
}

/** Inputs the trust block is computed from alongside the ledger. */
export interface TrustInputs {
  /** Commit the findings were computed against. */
  headSha: string;
  /**
   * Head-overlay verification (see `utils/head-content.ts`). When the overlay
   * was configured but changed blobs are missing from it, the run analyzed
   * checkout (base) bytes for those files — that is a coverage gap, so the
   * run is non-exhaustive (fail-closed) rather than silently base-stale.
   * @since NEXT
   */
  headContentExpected?: number;
  /** @since NEXT */
  headContentMaterialized?: number;
  /** @since NEXT */
  headContentMissing?: string[];
  /** @since NEXT */
  headContentOverlayConfigured?: boolean;
  /** Candidate findings before verification, filtering and caps. */
  candidatesConsidered?: number;
  /** Findings that survived to publication. */
  delivered?: number;
  /** True when a token/diff budget truncated what a pass was allowed to see. */
  budgetTruncated?: boolean;
  /** Findings whose anchor was confirmed by source-line comparison. */
  anchorsChecked?: number;
  /** Findings whose anchor resolved by existence-and-range only. */
  anchorsRangeChecked?: number;
  /** Findings whose anchor failed to resolve. */
  staleAnchors?: number;
  /** Human-readable reasons the run was not exhaustive. */
  incompleteReasons?: string[];
  /**
   * Passes this entry point is expected to account for.
   *
   * Defaults to every pass in {@link KNOWN_ZERO_FINDING_PASSES}. An audit does
   * not run the review-only passes, so it declares its own subset — otherwise
   * every audit would permanently report twelve uncovered passes and every
   * audit banner would stop meaning anything. A pass still does not excuse
   * itself by being expected: if it is expected and recorded as failing, that
   * is a gap like any other.
   */
  expectedPasses?: readonly string[];
}

/**
 * Fold a ledger and its run context into the published trust block.
 *
 * `exhaustive` is computed conservatively on purpose. It is true only when
 * every pass read every input, nothing was budget-truncated, and the pipeline
 * reported no incomplete reason — so a run that merely happened to find nothing
 * still cannot claim exhaustiveness. A `false` here is the honest default;
 * a `true` is a claim someone has to earn.
 *
 * @param ledger - Coverage recorded during the run.
 * @param inputs - Run-level context the ledger does not carry.
 * @returns The trust block attached to the result and rendered in the body.
 */
export function buildReviewTrust(ledger: CoverageLedger, inputs: TrustInputs): ReviewTrust {
  const passes = ledger.list();
  const gapped = passes.filter((e) => e.outcome === 'unreadable' || e.outcome === 'failed');
  const unreadableTotal = ledger.unreadableTotal();
  const failedClosed = gapped.some((e) => e.outcome === 'unreadable');

  const reasons: string[] = [...(inputs.incompleteReasons ?? [])];
  for (const e of gapped) {
    reasons.push(
      e.outcome === 'unreadable'
        ? `${e.pass}: ${e.unreadable} input(s) could not be read`
        : `${e.pass}: pass failed${e.reason ? ` (${e.reason})` : ''}`,
    );
  }
  if (inputs.budgetTruncated) reasons.push('context budget truncated the input');
  // Head-overlay gap (issue #1008): the checkout is pinned to the base SHA, so
  // a changed file with no overlay copy was read at base bytes (or not at
  // all). That is analyzing the wrong tree — a coverage gap, never a clean
  // result. Fail closed: force non-exhaustiveness with a named reason.
  // Overlay-unconfigured runs (local/CLI entry points with a real checkout)
  // are not penalized: without an overlay the checkout IS the tree.
  const headExpected = inputs.headContentExpected ?? 0;
  const headMaterialized = inputs.headContentMaterialized ?? headExpected;
  const headOverlayOn =
    inputs.headContentOverlayConfigured === true ||
    (inputs.headContentOverlayConfigured !== false &&
      (inputs.headContentMissing !== undefined ||
        (inputs.headContentExpected !== undefined &&
          inputs.headContentMaterialized !== undefined)));
  const headMissingCount = Math.max(0, headExpected - headMaterialized);
  if (headOverlayOn && headMissingCount > 0) {
    const missing = (inputs.headContentMissing ?? []).slice(0, 5);
    const more = headMissingCount > missing.length ? ', …' : '';
    reasons.push(
      `head-content overlay missing ${headMissingCount} file(s)` +
        (missing.length > 0 ? ` (${missing.join(', ')}${more})` : '') +
        ' — those files were read from the base checkout, not the PR head',
    );
  }
  // A stale anchor is a finding that cannot be checked against the commit this
  // verdict claims to describe. It does not invalidate the run, but it is a
  // gap in what was demonstrated, so it counts against exhaustiveness — which
  // is what puts the warning at the top of the comment rather than only in the
  // coverage table at the bottom.
  if ((inputs.staleAnchors ?? 0) > 0) {
    reasons.push(`${inputs.staleAnchors} finding(s) carry a line anchor that does not resolve`);
  }

  // Cross-check the ledger against the registry rather than trusting it. A pass
  // that can report zero findings and recorded nothing is not evidence of a
  // clean pass — it is evidence that nobody is watching that pass.
  const recorded = new Set(passes.map((p) => p.pass));
  const uncovered = (inputs.expectedPasses ?? KNOWN_ZERO_FINDING_PASSES).filter(
    (p) => !recorded.has(p),
  );
  if (uncovered.length > 0) {
    reasons.push(`${uncovered.length} pass(es) are not accounted for in this verdict`);
  }

  // Retention is only stated when both sides of the fraction were actually
  // tracked. An untracked candidate set yields null, which renders as "unknown"
  // — never rounded up to 1.0, because a null that reads as "100% covered" is
  // precisely the false green this block exists to prevent.
  const consideredKnown = typeof inputs.candidatesConsidered === 'number';
  const delivered = inputs.delivered ?? 0;
  const considered = inputs.candidatesConsidered ?? 0;
  const dropped = consideredKnown ? Math.max(0, considered - delivered) : 0;
  const findingRetention =
    consideredKnown && considered > 0 ? Math.min(1, Math.max(0, delivered / considered)) : null;

  const exhaustive =
    gapped.length === 0 &&
    !inputs.budgetTruncated &&
    uncovered.length === 0 &&
    reasons.length === 0;

  const statement = buildStatement({
    exhaustive,
    gapped,
    unreadableTotal,
    considered: consideredKnown ? considered : null,
    delivered,
    stale: inputs.staleAnchors ?? 0,
    uncovered,
  });

  return {
    headSha: inputs.headSha,
    passes,
    /** Total inputs across all passes that could not be read — the single
     * number a workflow can gate on. */
    unreadableInputs: unreadableTotal,
    /** Passes that can report zero findings but recorded nothing in this run.
     * Non-empty means the verdict is silent about part of its own pipeline. */
    uncovered,
    candidatesConsidered: considered,
    candidatesDropped: dropped,
    findingRetention,
    exhaustive,
    failedClosed,
    anchorsChecked: inputs.anchorsChecked ?? 0,
    anchorsRangeChecked: inputs.anchorsRangeChecked ?? 0,
    staleAnchors: inputs.staleAnchors ?? 0,
    statement,
    ...(inputs.headContentExpected !== undefined
      ? { headContentExpected: inputs.headContentExpected }
      : {}),
    ...(inputs.headContentMaterialized !== undefined
      ? { headContentMaterialized: inputs.headContentMaterialized }
      : {}),
    ...(inputs.headContentMissing !== undefined
      ? { headContentMissing: inputs.headContentMissing }
      : {}),
    ...(inputs.headContentOverlayConfigured !== undefined
      ? { headContentOverlayConfigured: inputs.headContentOverlayConfigured }
      : {}),
  };
}

/** Compose the one-sentence human statement. Kept separate for testability.
 * @param a - Aggregated coverage figures the statement is composed from.
 * @param a.exhaustive - Whether every pass read every input it set out to read.
 * @param a.gapped - Passes that ended `failed` or `unreadable`.
 * @param a.unreadableTotal - Total inputs across all passes that could not be read.
 * @param a.considered - Candidate findings considered, or null when untracked.
 * @param a.delivered - Candidate findings that survived to publication.
 * @param a.stale - Findings whose line anchor failed to resolve.
 * @param a.uncovered - Passes that recorded nothing in this run.
 * @returns The one-sentence human statement describing coverage.
 */
function buildStatement(a: {
  exhaustive: boolean;
  gapped: PassCoverage[];
  unreadableTotal: number;
  considered: number | null;
  delivered: number;
  stale: number;
  uncovered: readonly string[];
}): string {
  if (a.unreadableTotal > 0) {
    return (
      `Not an exhaustive review: ${a.unreadableTotal} input(s) could not be read and are UNSCANNED, ` +
      `not clean. Absence of findings here does not mean absence of defects.`
    );
  }
  if (a.gapped.length > 0) {
    // A pass that FAILED is not the same as an input that was truncated, and
    // saying so would be a second false signal: it tells the reader the review
    // was narrowed when it actually broke. Name the passes instead.
    const failed = a.gapped.filter((p) => p.outcome === 'failed').map((p) => `\`${p.pass}\``);
    if (failed.length > 0) {
      return (
        `Not an exhaustive review: ${failed.join(', ')} failed, so their coverage is absent ` +
        'rather than empty — nothing was found there because nothing looked.'
      );
    }
  }
  if (a.uncovered.length > 0) {
    return (
      `Not an exhaustive review: ${a.uncovered.length} pass(es) are not accounted for in this verdict ` +
      `(${a.uncovered.join(', ')}), so this says nothing about what they would have found.`
    );
  }
  if (!a.exhaustive) {
    return (
      'Not an exhaustive review: the input was truncated or partially processed, so findings here are ' +
      'a subset of what a full review would report.'
    );
  }
  const base = 'Every pass read every input it set out to read.';
  const retention =
    a.considered !== null
      ? ` ${a.considered} candidate finding(s) were considered and ${a.delivered} published.`
      : '';
  const stale = a.stale > 0 ? ` ${a.stale} finding(s) carry a stale line anchor.` : '';
  return `${base}${retention}${stale}`.trim();
}
