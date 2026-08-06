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

import { withRetryAndTimeout } from '../utils/retry.js';
import type { SCADependency, SCAVulnerability, Severity } from '../types/index.js';
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

/** Severity derived from a CVSS v3 score. */
export function severityFromCvss(score: number): Severity {
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'important';
  if (score >= 4.0) return 'minor';
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
function cvssV3BaseScore(vector: string): number | undefined {
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
  const selected =
    named.length > 0 ? named : affected.filter((entry) => !entry.package?.name);

  const candidates: string[] = [];
  for (const entry of selected) {
    for (const range of entry.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) candidates.push(event.fixed);
      }
    }
  }
  if (candidates.length === 0) return undefined;

  const newer = candidates
    .filter((v) => compareVersions(v, dep.version) > 0)
    .sort(compareVersions);
  if (newer.length > 0) return newer[0];
  return candidates[candidates.length - 1];
}

/**
 * Resolve the severity of an advisory for a dependency: CVSS score when present
 * (thresholds 9.0/7.0/4.0), else `database_specific.severity`, else `minor`.
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
  return { severity: mapped ?? 'minor' };
}

/**
 * Fetch a JSON payload from the OSV API with retry + timeout. Non-2xx
 * responses throw an error carrying the HTTP status so `withRetry` only retries
 * retryable codes (429, 5xx) and never swallows hard failures like 400/404.
 *
 * @param url - Full request URL.
 * @param init - Request init (method, headers, body, signal).
 * @param operationName - Name used in retry log messages.
 * @param fetchImpl - Fetch implementation (defaults to global fetch).
 * @returns The parsed JSON body.
 */
async function fetchOsvJson(
  url: string,
  init: RequestInit,
  operationName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  return withRetryAndTimeout(
    async (signal) => {
      const res = await fetchImpl(url, { ...init, signal });
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
    { operationName },
  );
}

/**
 * Run a `/v1/querybatch` request for a chunk of dependencies and return the
 * advisory ids matched, keyed by the dependency each match belongs to.
 *
 * @param deps - Dependencies for this batch (<= 1000).
 * @param fetchImpl - Fetch implementation (defaults to global fetch).
 * @returns Matches with their dependency.
 */
async function queryBatch(
  deps: SCADependency[],
  fetchImpl: typeof fetch,
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
 * @returns The hydrated advisory, or undefined when it no longer exists.
 */
async function hydrateVuln(id: string, fetchImpl: typeof fetch): Promise<OSVVulnerability | undefined> {
  try {
    const body = await fetchOsvJson(
      `${OSV_API_BASE}/v1/vulns/${encodeURIComponent(id)}`,
      {},
      'osv-vulns',
      fetchImpl,
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
 * @param options - Scan options (batch size, concurrency, fetch override).
 * @returns Known vulnerabilities for the given dependencies.
 */
export async function queryOSV(
  dependencies: SCADependency[],
  options: Pick<SCAScanOptions, 'maxBatchQueries' | 'concurrency' | 'fetchImpl'> = {},
): Promise<SCAVulnerability[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBatch = Math.max(1, options.maxBatchQueries ?? OSV_MAX_BATCH_QUERIES);
  const concurrency = options.concurrency ?? 8;

  // Phase 1: batched id matching.
  const matched: Array<{ dependency: SCADependency; match: OSVQueryMatch }> = [];
  for (let i = 0; i < dependencies.length; i += maxBatch) {
    const chunk = dependencies.slice(i, i + maxBatch);
    matched.push(...(await queryBatch(chunk, fetchImpl)));
  }

  if (matched.length === 0) return [];

  // Phase 2: hydrate unique ids in parallel.
  const uniqueIds = [...new Set(matched.map((m) => m.match.id))];
  const hydrated = await mapWithConcurrency(uniqueIds, concurrency, (id) => hydrateVuln(id, fetchImpl));
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
