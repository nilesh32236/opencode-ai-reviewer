import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Environment variable naming a directory that holds the pull request's
 * PROPOSED (head-SHA) file content, mirroring each changed file's
 * repo-relative path.
 *
 * The review job checks out the BASE sha on purpose (fix for #852: an
 * unpinned checkout would execute PR-controlled code with action secrets in
 * scope). That pin makes the worktree hold base content, which is exactly
 * wrong for content readers — a file the PR adds is missing entirely, and a
 * file the PR modifies reads at its pre-change bytes. The workflow therefore
 * materializes head blobs as DATA (`git show <headSha>:<path>`) into a
 * scan-only directory outside the checkout and points this variable at it.
 * Nothing in that directory is ever executed.
 *
 * Deliberately an environment variable and not a config field: repo config is
 * itself PR-controlled content, so a PR must not be able to redirect its own
 * reviewers at a directory of its choosing.
 */
export const PROPOSED_CONTENT_DIR_ENV = 'OPENCODE_PROPOSED_CONTENT_DIR';

/**
 * Optional environment variable carrying the head SHA the proposed-content
 * directory was materialized from. When set, attestation can state which tree
 * was verified; when unset the engine falls back to `pr.headSha` from the API
 * (which is head-correct but says nothing about what was actually read).
 */
export const HEAD_SHA_ENV = 'OPENCODE_HEAD_SHA';

/** Outcome of {@link verifyHeadContent}. */
export interface HeadContentVerification {
  /** Non-removed changed files that ought to have head content. */
  expected: number;
  /** How many of them had a materialized copy in the overlay. */
  materialized: number;
  /** Repo-relative paths with no overlay copy (capped for rendering). */
  missing: string[];
  /** True when the overlay directory was configured (env set, non-blank). */
  overlayConfigured: boolean;
}

/**
 * Resolve the absolute path a repo-relative file's HEAD content should be
 * read from, if the workflow materialized it.
 *
 * Returns `undefined` when the overlay is unset/blank or holds no copy of
 * that file — the caller then falls back to the checkout (correct content for
 * an unmodified file, base-stale content otherwise, which the attestation
 * below reports honestly instead of silently).
 *
 * `path.resolve` is applied so a relative value cannot escape into a parent
 * directory, and the joined path is confirmed to stay inside the resolved
 * root, so a changed-file path cannot traverse out of the overlay.
 *
 * @param filePath - Repo-relative path of the file.
 * @returns Absolute path of the head copy, or `undefined` if there is none.
 */
export function resolveHeadContentPath(filePath: string): string | undefined {
  const dir = process.env[PROPOSED_CONTENT_DIR_ENV]?.trim();
  if (!dir) return undefined;
  if (!filePath || typeof filePath !== 'string') return undefined;
  const root = path.resolve(dir);
  const candidate = path.resolve(root, filePath);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Resolve the overlay root directory, or `undefined` when unconfigured.
 * @returns Resolved absolute root, or `undefined`.
 */
export function resolveHeadContentRoot(): string | undefined {
  const dir = process.env[PROPOSED_CONTENT_DIR_ENV]?.trim();
  if (!dir) return undefined;
  return path.resolve(dir);
}

/**
 * Resolve the absolute path to read for a repo-relative file: head overlay
 * first, checkout second.
 *
 * This is the single choke point that keeps disk readers off the base tree
 * for changed files. Unmodified files are typically absent from the overlay
 * (the workflow materializes changed blobs only), so they resolve to the
 * checkout — which holds identical bytes at base and head for such files.
 *
 * @param workDir - Checkout root (fallback reader).
 * @param relPath - Repo-relative file path.
 * @returns Absolute path to read.
 */
export function resolveReadPath(workDir: string, relPath: string): string {
  const head = resolveHeadContentPath(relPath);
  if (head) return head;
  return path.join(workDir, relPath);
}

/**
 * Read a repo-relative file preferring head-overlay content.
 * @param workDir - Checkout root (fallback reader).
 * @param relPath - Repo-relative file path.
 * @returns File text, or `null` when neither root could provide it.
 */
export function readHeadFileSync(workDir: string, relPath: string): string | null {
  const head = resolveHeadContentPath(relPath);
  const candidates = head ? [head, path.join(workDir, relPath)] : [path.join(workDir, relPath)];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf-8');
    } catch {
      // Try the next root; fall through to null when both miss.
    }
  }
  return null;
}

/**
 * Verify how many of the PR's changed files were materialized into the head
 * overlay. Deleted files need no content and are excluded from the count.
 *
 * @param changedFiles - PR changed files (path + status).
 * @returns Counts plus the (capped) list of missing paths.
 */
export function verifyHeadContent(
  changedFiles: Array<{ path?: string | null; status?: string }> | undefined,
): HeadContentVerification {
  const overlayConfigured = Boolean(process.env[PROPOSED_CONTENT_DIR_ENV]?.trim());
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const relevant = files.filter(
    (f): f is { path: string; status?: string } =>
      typeof f?.path === 'string' && f.path.length > 0 && f.status !== 'removed',
  );
  const missing: string[] = [];
  let materialized = 0;
  for (const f of relevant) {
    if (resolveHeadContentPath(f.path)) materialized++;
    else if (missing.length < 20) missing.push(f.path);
  }
  return { expected: relevant.length, materialized, missing, overlayConfigured };
}

/**
 * Render the one-line attestation naming which tree was read, for the trust
 * section of the review body. States the head SHA under review and how many
 * changed blobs were verified against the overlay — e.g.
 * `Reviewed tree: \`abc1234\` (verified 12/12 blobs from head)`.
 *
 * A reader checking "did this verdict describe the code being merged" gets
 * the answer on the same screen as the verdict, not in a log they never see.
 * When blobs are missing the line says so loudly (and the trust block marks
 * the run non-exhaustive) instead of certifying base bytes as head content.
 *
 * @param headSha - Full head commit SHA the review claims to describe.
 * @param verification - Overlay verification counts.
 * @returns One-line markdown attestation.
 */
export function formatReviewedTreeLine(
  headSha: string,
  verification: HeadContentVerification,
): string {
  const short = (headSha || '').slice(0, 7) || 'unknown';
  if (!verification.overlayConfigured) {
    return (
      `Reviewed tree: \`${short}\` (head-content overlay not configured — ` +
      `file reads fell back to the checkout; verify the checkout ref before trusting line anchors)`
    );
  }
  const { expected, materialized } = verification;
  if (expected === 0) return `Reviewed tree: \`${short}\` (verified 0/0 blobs from head)`;
  if (materialized >= expected) {
    return `Reviewed tree: \`${short}\` (verified ${materialized}/${expected} blobs from head)`;
  }
  const missingCount = expected - materialized;
  const shown = verification.missing
    .slice(0, 5)
    .map((p) => `\`${p}\``)
    .join(', ');
  const more = missingCount > verification.missing.slice(0, 5).length ? ', …' : '';
  return (
    `Reviewed tree: \`${short}\` (verified ${materialized}/${expected} blobs from head — ` +
    `**${missingCount} file(s) missing from the head overlay**${shown ? `: ${shown}${more}` : ''}; ` +
    `unverified files were NOT certified clean)`
  );
}
