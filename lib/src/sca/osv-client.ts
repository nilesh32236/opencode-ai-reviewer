// OSV (Open Source Vulnerabilities) advisory client for the SCA pass.
//
// The scan follows the same two-phase flow used by `osv-scanner`:
//   1. `POST /v1/querybatch` with `{ package: { ecosystem, name }, version }`
//      queries. The response returns ONLY `{ id, modified }` per match
//      (positionally ordered to the input queries; `{}` = no match).
//   2. Each unique advisory id is hydrated via `GET /v1/vulns/{id}` in
//      parallel — full records carry `aliases` (CVE ids), `summary`,
//      `severity[]` (CVSS scores), and `affected[].ranges[].events[].fixed`.
//
// All calls go through `withRetryAndTimeout` and a failure in any phase is
// degraded gracefully by the caller: the SCA pass never crashes a review.

import type { SCADependency, SCAVulnerability, Severity } from '../types/index.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { withRetryAndTimeout } from '../utils/retry.js';
import type {
  OSVQuery,
  OSVQueryBatchResponse,
  OSVQueryMatch,
  OSVVulnerability,
  SCAScanOptions,
} from './types.js';

/** OSV public API base URL. */
export const OSV_API_BASE = 'https://api.osv.dev';

/** Hard cap of queries per `/v1/querybatch` request (OSV rejects > 1000). */
export const OSV_MAX_BATCH_QUERIES = 1000;

/** Per-attempt HTTP timeout and default retry tuning for OSV calls. */
const OSV_TIMEOUT_MS = 30_000;

/**
 * Shared circuit breaker for all OSV requests. Repeated API failures trip the
 * circuit so subsequent querybatch / hydration calls fail fast instead of
 * starting fresh retries for every batch and advisory. Reset automatically
 * after the cooldown window via the standard half-open probe.
 */
const osvCircuitBreaker = new CircuitBreaker({ name: 'osv-client' });

/**
 * Severity derived from a CVSS v3 score.
 *
 * Band mapping uses explicit thresholds: `>= 9.0` critical, `>= 7.0` important,
 * anything below maps to minor. Note that the CVSS "medium" band (4.0–6.9)
 * intentionally resolves to `minor` here and is therefore suppressed by the
 * default `minSeverity: 'important'` floor — a documented tradeoff that keeps
 * the default noise low. Repos that want medium findings can lower
 * `sca.minSeverity` to `'minor'`.
 * @param score - CVSS v3 base score (0–10).
 * @returns The mapped severity band.
 */
export function severityFromCvss(score: number): Severity {
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'important';
  return 'minor';
}

/** CVSS v3 base-score metric weights (CVSS 3.0 / 3.1). */
const CVSS_V3_AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const CVSS_V3_AC: Record<string, number> = { L: 0.77, H: 0.44 };
const CVSS_V3_UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CVSS_V3_CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/**
 * Compute the base score (0.0–10.0) of a CVSS v3/v3.1 vector string such as
 * `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:H/I:N/A:N`. OSV returns vectors in the
 * `severity[].score` field, so a numeric `parseFloat` cannot derive them.
 *
 * @param vector - Full CVSS vector (including the `CVSS:3.x/` prefix).
 * @returns The base score rounded to one decimal, or undefined when required
 * metrics are missing or the vector is not CVSS v3.
 */
export function cvssV3BaseScore(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//i.test(vector)) return undefined;
  const values = new Map<string, string>();
  for (const part of vector.split('/')) {
    const eq = part.indexOf(':');
    if (eq > 0) values.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const scopeChanged = values.get('S') === 'C';
  const av = CVSS_V3_AV[values.get('AV') ?? ''];
  const ac = CVSS_V3_AC[values.get('AC') ?? ''];
  const ui = CVSS_V3_UI[values.get('UI') ?? ''];
  const c = CVSS_V3_CIA[values.get('C') ?? ''];
  const i = CVSS_V3_CIA[values.get('I') ?? ''];
  const a = CVSS_V3_CIA[values.get('A') ?? ''];
  const pr = (scopeChanged ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[
    values.get('PR') ?? ''
  ];
  if (
    av === undefined ||
    ac === undefined ||
    pr === undefined ||
    ui === undefined ||
    c === undefined ||
    i === undefined ||
    a === undefined
  ) {
    return undefined;
  }
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const exploitability = 8.22 * av * ac * pr * ui;
  let score: number;
  if (scopeChanged) {
    const impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
    score = Math.min(1.08 * (impact + exploitability), 10);
  } else {
    score = Math.min(6.42 * iss + exploitability, 10);
  }
  return Math.min(10, Math.ceil(score * 10) / 10);
}

/**
 * Map an OSV `database_specific.severity` label to the project severity.
 * Unknown labels degrade to `minor` so findings are never over-reported.
 * @param label - The OSV severity label (may be undefined).
 * @returns The mapped severity, or `minor` for unknown/absent labels.
 */
export function severityFromOsvLabel(label: string | undefined): Severity | undefined {
  switch ((label ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
    case 'IMPORTANT':
      return 'important';
    case 'MODERATE':
    case 'LOW':
    case 'MINOR':
      return 'minor';
    default:
      return undefined;
  }
}

/**
 * Build the OSV `querybatch` request payload for a dependency batch.
 *
 * @param deps - Dependencies to query (chunk must be <= 1000 entries).
 * @returns The JSON payload for `POST /v1/querybatch`.
 */
export function buildBatchQueries(deps: SCADependency[]): { queries: OSVQuery[] } {
  return {
    queries: deps.map((dep) => ({
      package: { ecosystem: dep.ecosystem, name: dep.name },
      version: dep.version,
    })),
  };
}

/**
 * Extract CVE ids from an advisory's `aliases`. Returns only the aliases that
 * look like real CVEs — the GHSA-only fallback (reporting the advisory id
 * itself) is handled by the caller via `cveIds[0] ?? id` in
 * {@link scaVulnerabilityToIssue}.
 *
 * @param vuln - Hydrated advisory record.
 * @returns A list of CVE ids (may be empty).
 */
export function extractCveIds(vuln: OSVVulnerability): string[] {
  const cves = (vuln.aliases ?? []).filter((alias) => /^CVE-\d{4}-\d+$/i.test(alias));
  return cves.length > 0 ? cves : [];
}

/**
 * Compare two numeric dot-separated versions (`1.2.3` vs `7.18.9`), tolerating
 * a leading `v` and non-numeric suffixes. Used to prefer a fixed version newer
 * than the dependency's current one.
 *
 * @param a - First version.
 * @param b - Second version.
 * @returns Negative when `a < b`, zero when equal, positive when `a > b`.
 */
function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/**
 * Extract the best fixed version for a dependency from an advisory's `affected`
 * entries. Scopes to the queried package's own affected entry, falling back to
 * package-less entries only when no named match exists. Among all `fixed`
 * events it prefers the lowest version newer than the dependency's current
 * version; when none is newer it returns the last one in document order (OSV
 * lists patched versions newest-last).
 *
 * @param vuln - Hydrated advisory record.
 * @param dep - The dependency the advisory applies to.
 * @returns The fixed version, or undefined when the advisory offers none.
 */
export function extractFixedVersion(
  vuln: OSVVulnerability,
  dep: SCADependency,
): string | undefined {
  const affected = vuln.affected ?? [];
  const named = affected.filter((entry) => entry.package?.name === dep.name);
  const selected = named.length > 0 ? named : affected.filter((entry) => !entry.package?.name);

  const candidates: string[] = [];
  for (const entry of selected) {
    for (const range of entry.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) candidates.push(event.fixed);
      }
    }
  }
  if (candidates.length === 0) return undefined;

  const newer = candidates.filter((v) => compareVersions(v, dep.version) > 0).sort(compareVersions);
  if (newer.length > 0) return newer[0];
  return candidates[candidates.length - 1];
}

/**
 * Resolve the severity of an advisory for a dependency: CVSS score when present
 * (thresholds 9.0/7.0), else `database_specific.severity`, else `important`.
 *
 * The final fallback is `important` (not `minor`) so advisories whose OSV record
 * lacks severity metadata — e.g. the Go vulndb, which rarely sets CVSS/labels —
 * still surface for human triage instead of being silently dropped by the
 * default `minSeverity: 'important'` floor.
 *
 * @param vuln - Hydrated advisory record.
 * @returns The projected severity and raw CVSS score (when available).
 */
export function resolveSeverity(vuln: OSVVulnerability): {
  severity: Severity;
  cvssScore?: number;
} {
  for (const entry of vuln.severity ?? []) {
    const raw = entry.score ?? '';
    const numeric = Number.parseFloat(raw);
    if (Number.isFinite(numeric)) {
      return { severity: severityFromCvss(numeric), cvssScore: numeric };
    }
    // GHSA advisories (the common source for npm/PyPI/Go/RubyGems) carry CVSS
    // vector strings in `severity[].score`; parse the base score instead of
    // treating the vector as unparseable and under-reporting severity.
    const vectorScore = cvssV3BaseScore(raw);
    if (vectorScore !== undefined) {
      return { severity: severityFromCvss(vectorScore), cvssScore: vectorScore };
    }
  }
  const label = vuln.database_specific?.severity ?? vuln.ecosystem_specific?.severity;
  const mapped = severityFromOsvLabel(label);
  return { severity: mapped ?? 'important' };
}

/**
 * Fetch a JSON payload from the OSV API with retry + timeout. Non-2xx
 * responses throw an error carrying the HTTP status so `withRetry` only retries
 * retryable codes (429, 5xx) and never swallows hard failures like 400/404.
 *
 * An optional `signal` enables an overall scan deadline: it is forwarded to the
 * retry loop AND combined with the per-attempt timeout so an in-flight request
 * is aborted the moment the deadline fires, bounding the total wall-clock time
 * the pipeline waits on api.osv.dev.
 *
 * @param url - Full request URL.
 * @param init - Request init (method, headers, body).
 * @param operationName - Name used in retry log messages.
 * @param fetchImpl - Fetch implementation (defaults to global fetch).
 * @param signal - Optional AbortSignal (overall scan deadline).
 * @returns The parsed JSON body.
 */
async function fetchOsvJson(
  url: string,
  init: RequestInit,
  operationName: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  return osvCircuitBreaker.call(() =>
    withRetryAndTimeout(
      async (attemptSignal) => {
        // Combine the per-attempt timeout with the overall scan deadline so a
        // deadline abort cancels an in-flight request immediately.
        const combined = signal ? combineSignals(attemptSignal, signal) : attemptSignal;
        const res = await fetchImpl(url, { ...init, signal: combined });
        if (!res.ok) {
          const err = new Error(`OSV API ${res.status} ${res.statusText}`) as Error & {
            status: number;
          };
          err.status = res.status;
          throw err;
        }
        return res.json();
      },
      OSV_TIMEOUT_MS,
      { operationName, signal },
    ),
  );
}

/**
 * Build an AbortSignal that aborts as soon as either parent signal aborts.
 * Uses `AbortSignal.any` when available (Node >= 20.3) and falls back to a
 * manual controller + listeners otherwise.
 *
 * @param a - First signal.
 * @param b - Second signal.
 * @returns A signal aborted when `a` or `b` aborts.
 */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/** The AbortError name at runtime (DOMException). */
const ABORT_ERR_NAME = 'AbortError';

/**
 * True when the thrown value signals a scan-deadline abort.
 * @param err - The thrown value to inspect.
 * @returns True when the value is an `AbortError`.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === ABORT_ERR_NAME;
}

/**
 * Run a `/v1/querybatch` request for a chunk of dependencies and return the
 * advisory ids matched, keyed by the dependency each match belongs to.
 *
 * @param deps - Dependencies for this batch (<= 1000).
 * @param fetchImpl - Fetch implementation (defaults to global fetch).
 * @param signal - Optional overall scan-deadline signal.
 * @returns Matches with their dependency.
 */
async function queryBatch(
  deps: SCADependency[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Array<{ dependency: SCADependency; match: OSVQueryMatch }>> {
  const payload = buildBatchQueries(deps);
  const body = await fetchOsvJson(
    `${OSV_API_BASE}/v1/querybatch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'osv-querybatch',
    fetchImpl,
    signal,
  );
  const parsed = body as OSVQueryBatchResponse;
  const results = parsed.results ?? [];
  const matches: Array<{ dependency: SCADependency; match: OSVQueryMatch }> = [];
  for (let i = 0; i < deps.length; i++) {
    const result = results[i];
    for (const vuln of result?.vulns ?? []) {
      matches.push({ dependency: deps[i], match: vuln });
    }
    // `next_page_token` only appears for pathological single-query result sets
    // (>1000 vulns for one dependency); those findings are out of scope.
  }
  return matches;
}

/**
 * Hydrate a single advisory id via `GET /v1/vulns/{id}`. A 404 is skipped (the
 * advisory was removed); transport/5xx errors propagate so the caller degrades.
 *
 * @param id - OSV advisory id.
 * @param fetchImpl - Fetch implementation.
 * @param signal - Optional overall scan-deadline signal.
 * @returns The hydrated advisory, or undefined when it no longer exists.
 */
async function hydrateVuln(
  id: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<OSVVulnerability | undefined> {
  try {
    const body = await fetchOsvJson(
      `${OSV_API_BASE}/v1/vulns/${encodeURIComponent(id)}`,
      {},
      'osv-vulns',
      fetchImpl,
      signal,
    );
    return body as OSVVulnerability;
  } catch (err) {
    if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Run N async tasks under a fixed concurrency bound.
 *
 * @param items - Items to process.
 * @param concurrency - Max parallel tasks.
 * @param fn - Async worker per item.
 * @returns Results in input order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  for (let w = 0; w < limit; w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const idx = next++;
          results[idx] = await fn(items[idx]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/**
 * Query the OSV advisory database for a list of changed dependencies and return
 * every known vulnerability, hydrated with CVE ids, severity, CVSS score, and
 * the best fixed version. The caller owns graceful degradation (returns `[]` on
 * any network / parse failure).
 *
 * @param dependencies - Changed dependencies to check.
 * @param options - Scan options (batch size, concurrency, fetch override, signal).
 * @returns Known vulnerabilities for the given dependencies.
 */
export async function queryOSV(
  dependencies: SCADependency[],
  options: Pick<SCAScanOptions, 'maxBatchQueries' | 'concurrency' | 'fetchImpl' | 'signal'> = {},
): Promise<SCAVulnerability[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBatch = Math.max(1, options.maxBatchQueries ?? OSV_MAX_BATCH_QUERIES);
  const concurrency = options.concurrency ?? 8;
  const signal = options.signal;

  // Phase 1: batched id matching.
  const matched: Array<{ dependency: SCADependency; match: OSVQueryMatch }> = [];
  for (let i = 0; i < dependencies.length; i += maxBatch) {
    const chunk = dependencies.slice(i, i + maxBatch);
    matched.push(...(await queryBatch(chunk, fetchImpl, signal)));
  }

  if (matched.length === 0) return [];

  // Phase 2: hydrate unique ids in parallel. A single advisory hydration must
  // never sink the whole scan: a persistent 5xx/403/rate-limit failure on one
  // advisory is skipped (returns undefined) so the remaining advisories still
  // surface. The per-attempt retry + circuit breaker still count the failure.
  const uniqueIds = [...new Set(matched.map((m) => m.match.id))];
  const hydrated = await mapWithConcurrency(
    uniqueIds,
    concurrency,
    async (id): Promise<OSVVulnerability | undefined> => {
      try {
        return await hydrateVuln(id, fetchImpl, signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        return undefined;
      }
    },
  );
  const byId = new Map<string, OSVVulnerability>();
  for (let i = 0; i < uniqueIds.length; i++) {
    const vuln = hydrated[i];
    if (vuln) byId.set(uniqueIds[i], vuln);
  }

  const results: SCAVulnerability[] = [];
  for (const { dependency, match } of matched) {
    const vuln = byId.get(match.id);
    if (!vuln) continue; // advisory removed from the database
    const { severity, cvssScore } = resolveSeverity(vuln);
    results.push({
      dependency,
      id: vuln.id,
      cveIds: extractCveIds(vuln),
      summary: vuln.summary ?? '',
      severity,
      cvssScore,
      fixedVersion: extractFixedVersion(vuln, dependency),
      references: (vuln.references ?? []).map((r) => r.url ?? '').filter(Boolean),
    });
  }
  return results;
}
