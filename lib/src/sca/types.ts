// Domain types for the Software Composition Analysis (SCA) subsystem.
//
// The shared dependency / vulnerability / config shapes live in
// `lib/src/types/index.ts` (they are referenced by `AgentConfig`), so this
// module re-exports them and adds the OSV API wire shapes plus scan options
// used internally by the lock-file parser, OSV client, and orchestrator.

import type { Severity } from '../types/index.js';

export type { Ecosystem, SCADependency, SCAVulnerability, SCAConfig } from '../types/index.js';
export { DEFAULT_SCA_LOCK_FILE_PATTERNS } from '../types/index.js';

/** Tunables for the SCA scan orchestrator. */
export interface SCAScanOptions {
  /** Whether the SCA pass is enabled at all. */
  enabled: boolean;
  /** Findings below this severity are dropped. */
  minSeverity: Severity;
  /** Glob patterns identifying dependency lock files to scan. */
  lockFilePatterns: string[];
  /** Glob patterns for lock files to skip. */
  excludePatterns: string[];
  /** Optional `fetch` override for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Max queries per OSV querybatch request (OSV hard-caps at 1000). */
  maxBatchQueries?: number;
  /** Bounded concurrency for advisory hydration requests. */
  concurrency?: number;
}

// ─── OSV API wire shapes ─────────────────────────────────

/** A single `package` + `version` query sent to `/v1/querybatch`. */
export interface OSVQuery {
  package: { ecosystem: string; name: string };
  version?: string;
}

/** A `{ id, modified }` match returned per query by `/v1/querybatch`. */
export interface OSVQueryMatch {
  id: string;
  modified: string;
}

/** Per-query result entry from the `/v1/querybatch` response body. */
export interface OSVQueryResult {
  vulns?: OSVQueryMatch[];
  next_page_token?: string;
}

/** Response body of `POST /v1/querybatch`. Results are positionally ordered. */
export interface OSVQueryBatchResponse {
  results?: OSVQueryResult[];
}

/** A single range event (`introduced` / `fixed` / `last_affected`). */
export interface OSVVulnEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

/** An `affected[]` entry scoping an advisory to one or more packages. */
export interface OSVAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: Array<{ type?: string; events?: OSVVulnEvent[] }>;
  versions?: string[];
  database_specific?: Record<string, unknown>;
}

/** A CVSS-style severity entry carried by `severity[]`. */
export interface OSVSeverity {
  type?: string;
  score?: string;
}

/** Full advisory record returned by `GET /v1/vulns/{id}`. */
export interface OSVVulnerability {
  id: string;
  modified?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: OSVSeverity[];
  database_specific?: { severity?: string; [key: string]: unknown };
  ecosystem_specific?: { severity?: string; [key: string]: unknown };
  affected?: OSVAffected[];
  references?: Array<{ type?: string; url?: string }>;
}
