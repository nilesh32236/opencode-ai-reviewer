import type { HeadCIStatus, PlatformAdapter } from '../platform/adapter.js';

/** Single CI check entry contributing to a head-SHA rollup. */
export interface HeadCICheck {
  /** Check / context name. */
  name: string;
  /** Raw check status (e.g. `completed`, `in_progress`, `queued`). */
  status: string;
  /** Raw conclusion (e.g. `success`, `failure`, `skipped`, `pending`). */
  conclusion: string;
}

/** Options for {@link isHeadCIGreen}. */
export interface HeadCIGreenOptions {
  /**
   * Subset of check names that must be present with SUCCESS.
   * When omitted, every observed check must be successful (modulo
   * `allowSkipped`).
   */
  requireNames?: string[];
  /**
   * When false (default), `skipped`/`neutral`/`cancelled` conclusions block
   * green (skipped != verified). Set true to allow them.
   */
  allowSkipped?: boolean;
}

/**
 * Determine whether a head-SHA CI status counts as green (fail closed).
 *
 * Fail-closed rules:
 * - `total === 0` (CI never ran on the head, e.g. `[skip ci]` pushes or
 *   event-delivery gaps) is NEVER green.
 * - Any pending check blocks green.
 * - Any failed check blocks green.
 * - Unless `allowSkipped` is true, skipped/neutral/cancelled conclusions
 *   block green (skipped != verified).
 * - Negative counters are malformed and block green (a buggy adapter must
 *   never read green).
 * - Raw `checks[]` entries are cross-checked even without `requireNames`:
 *   every observed entry must be `completed`/`success` (modulo
 *   `allowSkipped`), so a failure entry paired with clean counters (buggy
 *   adapter) still blocks green. An empty `checks[]` trusts the counters
 *   (counter-only adapters); a non-array `checks` value is malformed.
 * - When `requireNames` is supplied, every listed name must be present with
 *   a `success` conclusion (case-insensitive name match).
 *
 * Pure function (no I/O), safe to unit test.
 * @param status - Aggregated head CI status.
 * @param opts - Optional name-subset / skipped policy.
 * @returns True only when the head SHA has verified green CI.
 */
export function isHeadCIGreen(
  status: Pick<HeadCIStatus, 'total' | 'pending' | 'failed' | 'skipped' | 'checks'>,
  opts?: HeadCIGreenOptions,
): boolean {
  if (!status) return false;
  // Fail closed on malformed counters: missing/NaN/Infinity/negative must
  // never be green.
  if (
    !Number.isFinite(status.total) ||
    !Number.isFinite(status.pending) ||
    !Number.isFinite(status.failed) ||
    !Number.isFinite(status.skipped)
  )
    return false;
  if (status.total <= 0) return false;
  // Fail closed on negative counters: a buggy adapter reporting e.g.
  // `pending: -1` must never read green.
  if (status.pending < 0 || status.failed < 0 || status.skipped < 0) return false;
  if (status.pending > 0) return false;
  if (status.failed > 0) return false;
  if (opts?.allowSkipped !== true && status.skipped > 0) return false;
  const allowSkipped = opts?.allowSkipped === true;
  // Cross-check raw entries even without `requireNames`: a failure/skipped
  // entry in `checks[]` with clean counters (buggy adapter) must block
  // green. Malformed entries (missing status/conclusion) coerce to
  // non-success and block. Empty `checks[]` trusts the counters above
  // (counter-only adapters); a non-array value is malformed.
  if (status.checks !== undefined) {
    if (!Array.isArray(status.checks)) return false;
    for (const check of status.checks) {
      const entryStatus = String(check?.status ?? '').toLowerCase();
      const conclusion = String(check?.conclusion ?? '').toLowerCase();
      if (entryStatus !== 'completed') return false;
      if (conclusion === 'success') continue;
      if (
        allowSkipped &&
        (conclusion === 'skipped' || conclusion === 'neutral' || conclusion === 'cancelled')
      )
        continue;
      return false;
    }
  }
  // Coerce before filtering: type-violating null/undefined entries must fail
  // closed (no match) instead of throwing on `n.length`.
  const requireNames =
    opts?.requireNames?.filter((n): n is string => typeof n === 'string' && n.length > 0) ?? [];
  if (requireNames.length > 0) {
    const byName = new Map<string, HeadCICheck[]>();
    const checks = Array.isArray(status.checks) ? status.checks : [];
    for (const check of checks) {
      // Coerce: malformed adapter entries (undefined name) must block green,
      // never throw. Empty-string keys simply never match a required name.
      const key = String(check?.name ?? '').toLowerCase();
      const list = byName.get(key);
      if (list) list.push(check);
      else byName.set(key, [check]);
    }
    for (const required of requireNames) {
      const entries = byName.get(String(required).toLowerCase());
      if (!entries || entries.length === 0) return false;
      // Every matching check for a required name must be successful; a
      // same-named failure/pending/skipped run blocks green. Malformed
      // entries (missing status/conclusion) coerce to non-success and block.
      const allSuccess = entries.every(
        (c) =>
          String(c?.status ?? '').toLowerCase() === 'completed' &&
          String(c?.conclusion ?? '').toLowerCase() === 'success',
      );
      if (!allSuccess) return false;
    }
  }
  return true;
}

/** Result of a fail-closed head-CI gate evaluation. */
export interface HeadCIGateResult {
  /** True only when the head SHA has verified green CI. */
  ok: boolean;
  /** Human-readable reason (for warnings/comments). */
  reason: string;
}

/**
 * Fail-closed gate: query `getHeadCIStatus` for a commit SHA and evaluate
 * {@link isHeadCIGreen}. Any error, missing adapter method, empty rollup,
 * pending/failed/skipped check, or SHA mismatch yields `{ ok: false }` —
 * callers must NOT apply `autofix:ready` (or merge) when `ok` is false.
 *
 * The adapter is typed as `Pick<PlatformAdapter, 'getHeadCIStatus'>`-ish via
 * a structural parameter so unit tests can pass plain mocks without
 * implementing the full adapter.
 * @param adapter - Platform adapter (or mock exposing `getHeadCIStatus`).
 * @param commitSha - Exact head SHA CI must be green on.
 * @param opts - Optional green-policy options (forwarded to `isHeadCIGreen`).
 * @param signal - Optional AbortSignal.
 * @returns Gate result with a human-readable reason.
 */
export async function checkHeadCIGreen(
  adapter: Pick<PlatformAdapter, 'getHeadCIStatus'> | Record<string, unknown>,
  commitSha: string,
  opts?: HeadCIGreenOptions,
  signal?: AbortSignal,
): Promise<HeadCIGateResult> {
  // Guard typeof before trim: a non-string truthy value (via `any`) must fail
  // closed with a reason instead of throwing a TypeError.
  if (typeof commitSha !== 'string' || commitSha.trim() === '') {
    return { ok: false, reason: 'missing head SHA — cannot verify CI' };
  }
  const getStatus = (adapter as Pick<PlatformAdapter, 'getHeadCIStatus'>)?.getHeadCIStatus;
  if (typeof getStatus !== 'function') {
    return {
      ok: false,
      reason: `no CI signal for ${commitSha.slice(0, 7)} (adapter has no CI query)`,
    };
  }
  let status: HeadCIStatus;
  try {
    status = await (getStatus as (sha: string, signal?: AbortSignal) => Promise<HeadCIStatus>).call(
      adapter,
      commitSha,
      signal,
    );
  } catch (err) {
    return {
      ok: false,
      reason: `CI query failed for ${commitSha.slice(0, 7)} — treating as not green: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!status || status.commitSha !== commitSha) {
    return {
      ok: false,
      reason: `CI status SHA mismatch (expected ${commitSha.slice(0, 7)}, got ${String(status?.commitSha ?? 'none').slice(0, 7)}) — treating as not green`,
    };
  }
  try {
    if (
      !Number.isFinite(status.total) ||
      !Number.isFinite(status.pending) ||
      !Number.isFinite(status.failed) ||
      !Number.isFinite(status.skipped) ||
      status.total < 0 ||
      status.pending < 0 ||
      status.failed < 0 ||
      status.skipped < 0
    ) {
      return {
        ok: false,
        reason: `malformed CI status for ${commitSha.slice(0, 7)} — treating as not green`,
      };
    }
    if (status.total <= 0) {
      return {
        ok: false,
        reason: `no CI checks reported for ${commitSha.slice(0, 7)} (empty rollup) — treating as not green`,
      };
    }
    if (!isHeadCIGreen(status, opts)) {
      return {
        ok: false,
        reason: `CI not green for ${commitSha.slice(0, 7)} (total=${status.total} pending=${status.pending} failed=${status.failed} skipped=${status.skipped})`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `malformed CI status for ${commitSha.slice(0, 7)} — treating as not green: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, reason: `CI green for ${commitSha.slice(0, 7)} (${status.total} checks)` };
}
