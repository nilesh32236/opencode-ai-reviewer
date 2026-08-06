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
 * Extract CVE ids from an advisory's `aliases`. Returns the aliases that look
 * like real CVEs; when none are present, falls back to the advisory id so a
 * GHSA-only advisory is still reported by its own id.
 *
 * @param vuln - Hydrated advisory record.
 * @returns A list of CVE ids (may be empty).
 */
export function extractCveIds(vuln: OSVVulnerability): string[] {
  const cves = (vuln.aliases ?? []).filter((alias) => /^CVE-\d{4}-\d+$/i.test(alias));
  return cves.length > 0 ? cves : [];
}

/**
 * Extract the best fixed version for a dependency from an advisory's `affected`
 * entries, scoped to the queried package's own affected entry. When multiple
 * `fixed` events exist (several ranges), the last one in document order wins —
 * OSV lists patched versions newest-last.
 *
 * @param vuln - Hydrated advisory record.
 * @param dep - The dependency the advisory applies to.
 * @returns The fixed version, or undefined when the advisory offers none.
 */
export function extractFixedVersion(
  vuln: OSVVulnerability,
  dep: SCADependency,
): string | undefined {
  const affected = (vuln.affected ?? []).find((entry) => {
    const name = entry.package?.name;
    if (!name) return true; // no package scope — treat as applying to everything
    return name === dep.name;
  });
  if (!affected?.ranges) return undefined;
  let fixed: string | undefined;
  for (const range of affected.ranges) {
    for (const event of range.events ?? []) {
      if (event.fixed) fixed = event.fixed;
    }
  }
  return fixed;
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
    const score = Number.parseFloat(entry.score ?? '');
    if (Number.isFinite(score)) {
      return { severity: severityFromCvss(score), cvssScore: score };
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
 * @returns The parsed JSON body.
 */
async function fetchOsvJson(
  url: string,
  init: RequestInit,
  operationName: string,
): Promise<unknown> {
  return withRetryAndTimeout(
    async (signal) => {
      const res = await fetch(url, { ...init, signal });
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
    const body = await fetchOsvJson(`${OSV_API_BASE}/v1/vulns/${encodeURIComponent(id)}`, {}, 'osv-vulns');
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
  const maxBatch = options.maxBatchQueries ?? OSV_MAX_BATCH_QUERIES;
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
