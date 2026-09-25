/**
 * Fail-closed validation for SEC-001 job-isolation patch artifacts.
 *
 * Patch artifacts cross the trust boundary between isolated GitHub jobs
 * (agent → verify → publish). Every consumer must treat them as untrusted
 * input: a compromised or buggy producer must not be able to smuggle paths,
 * symlinks, oversized payloads, or mismatched base SHAs into a trusted
 * publish job. This module is a pure, additive validator — it performs no
 * filesystem or network I/O so workflows and tests can call it
 * deterministically before applying any patch.
 *
 * Out of scope: secret isolation of OpenCode's internal tool subprocesses
 * (documented residual in SEC-001 design), model routing, and merge-approval
 * policy (see `merge-approval.ts`).
 */

/** Hex-encoded SHA-256 digest pattern (lowercase or uppercase accepted). */
export const ARTIFACT_SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

/** Plausible git commit SHA: hex, 4–64 chars (full or abbreviated). */
export const ARTIFACT_BASE_SHA_PATTERN = /^[0-9a-fA-F]{4,64}$/;

/** Maximum number of files a single patch artifact may carry. */
export const MAX_ARTIFACT_FILES = 200;

/** Maximum total payload size per patch artifact (5 MiB). */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

/** Maximum length of a single artifact-relative path. */
export const MAX_ARTIFACT_PATH_CHARS = 512;

/**
 * Path segments that must never appear in an artifact file list.
 * `.git/` internals would let a patch rewrite hooks, refs, or replace
 * objects consumed by a later trusted git operation.
 */
export const FORBIDDEN_PATH_SEGMENTS: ReadonlyArray<string> = ['.git'];

/**
 * Exact file paths (artifact-relative, posix) that an agent patch must never
 * carry. Workflow files change the trust boundary itself; secret-adjacent
 * files risk credential exfiltration or persistence.
 */
export const FORBIDDEN_ARTIFACT_PATHS: ReadonlySet<string> = new Set([
  '.github/workflows/hourly-orchestrator.yml',
  '.github/workflows/self-improvement.yml',
  '.github/workflows/ai-review.yml',
  '.github/workflows/ci.yml',
  '.env',
  '.env.platform',
]);

/** A single file carried by a patch artifact. */
export interface ArtifactFileEntry {
  /** Artifact-relative posix path (e.g. `lib/src/utils/foo.ts`). */
  path: string;
  /** Byte size of the file payload. */
  size: number;
  /** True when the producer recorded this entry as a symlink. */
  symlink: boolean;
}

/** Untrusted patch-artifact metadata produced by an agent/repair job. */
export interface PatchArtifact {
  /** Unique run identifier shared across agent/verify/publish jobs. */
  runId: string;
  /** Base commit SHA the patch was generated against. */
  baseSha: string;
  /** Monotonic attempt number (initial agent attempt is 0 or 1). */
  attempt: number;
  /** Files carried by the artifact. */
  files: ArtifactFileEntry[];
  /** Declared total payload bytes (must match the sum of `files[*].size`). */
  byteCount: number;
  /** SHA-256 hex digest of the canonical patch payload. */
  sha256: string;
}

/** Machine-readable outcome of {@link validatePatchArtifact}. */
export interface ArtifactValidationResult {
  /** True only when every fail-closed check passes. */
  ok: boolean;
  /** Stable machine-readable reason (`valid` when `ok` is true). */
  reason: string;
}

/**
 * Validate one artifact-relative path without touching the filesystem.
 *
 * @param filePath - Candidate artifact-relative posix path.
 * @returns Null when the path is safe; otherwise a machine-readable reason.
 */
export function validateArtifactPath(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return 'empty-path';
  if (filePath.length > MAX_ARTIFACT_PATH_CHARS) return 'path-too-long';
  if (filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath)) return 'absolute-path';
  if (filePath.includes('\\')) return 'backslash-path';
  if (filePath.startsWith('~')) return 'home-relative-path';
  const segments = filePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'traversal-segment';
  }
  if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.includes(segment))) {
    return 'forbidden-segment';
  }
  if (FORBIDDEN_ARTIFACT_PATHS.has(filePath)) return 'forbidden-path';
  if (filePath === 'action/lib/index.js' || filePath.startsWith('action/lib/')) {
    return 'forbidden-path';
  }
  return null;
}

/**
 * Validate patch-artifact metadata and file list as untrusted input.
 *
 * Fail-closed: any missing field, checksum mismatch, base-SHA mismatch
 * against the expected base, path traversal, symlink entry, forbidden path,
 * byte-count mismatch, or size/count overflow yields `{ ok: false }`.
 *
 * @param artifact - Untrusted artifact value (validated structurally).
 * @param options - Expected base SHA and actual payload digest for comparison.
 * @param options.expectedBaseSha - Base commit SHA the consumer checked out.
 * @param options.actualSha256 - SHA-256 of the canonical payload just downloaded.
 * @returns The validation outcome; `reason` is `valid` on success.
 */
export function validatePatchArtifact(
  artifact: unknown,
  options: { expectedBaseSha: string; actualSha256: string },
): ArtifactValidationResult {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.expectedBaseSha !== 'string' ||
    typeof options.actualSha256 !== 'string'
  ) {
    return { ok: false, reason: 'invalid-options' };
  }
  if (typeof artifact !== 'object' || artifact === null)
    return { ok: false, reason: 'not-an-object' };
  const candidate = artifact as Partial<PatchArtifact>;
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) {
    return { ok: false, reason: 'missing-run-id' };
  }
  if (typeof candidate.baseSha !== 'string' || !ARTIFACT_BASE_SHA_PATTERN.test(candidate.baseSha)) {
    return { ok: false, reason: 'invalid-base-sha' };
  }
  if (candidate.baseSha.toLowerCase() !== options.expectedBaseSha.toLowerCase()) {
    return { ok: false, reason: 'base-sha-mismatch' };
  }
  if (!Number.isInteger(candidate.attempt) || (candidate.attempt as number) < 0) {
    return { ok: false, reason: 'invalid-attempt' };
  }
  if (!Array.isArray(candidate.files)) return { ok: false, reason: 'missing-files' };
  if (candidate.files.length === 0) return { ok: false, reason: 'empty-files' };
  if (candidate.files.length > MAX_ARTIFACT_FILES) return { ok: false, reason: 'too-many-files' };
  if (typeof candidate.byteCount !== 'number' || !Number.isInteger(candidate.byteCount)) {
    return { ok: false, reason: 'invalid-byte-count' };
  }
  if (typeof candidate.sha256 !== 'string' || !ARTIFACT_SHA256_PATTERN.test(candidate.sha256)) {
    return { ok: false, reason: 'invalid-sha256' };
  }
  if (candidate.sha256.toLowerCase() !== options.actualSha256.toLowerCase()) {
    return { ok: false, reason: 'checksum-mismatch' };
  }
  let total = 0;
  const seen = new Set<string>();
  for (const entry of candidate.files as ArtifactFileEntry[]) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, reason: 'invalid-entry' };
    const pathReason = validateArtifactPath(entry.path);
    if (pathReason !== null) return { ok: false, reason: pathReason };
    if (seen.has(entry.path)) return { ok: false, reason: 'duplicate-path' };
    seen.add(entry.path);
    if (entry.symlink) return { ok: false, reason: 'symlink-entry' };
    if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) {
      return { ok: false, reason: 'invalid-entry-size' };
    }
    total += entry.size;
    if (total > MAX_ARTIFACT_BYTES) return { ok: false, reason: 'payload-too-large' };
  }
  if (total !== candidate.byteCount) return { ok: false, reason: 'byte-count-mismatch' };
  return { ok: true, reason: 'valid' };
}
