import { createHash } from 'node:crypto';
import * as core from '@actions/core';
import { buildInlineCommentsWithSpillover } from '../jsonl-parser.js';
import type {
  BotReviewInfo,
  HeadCIStatus,
  PlatformAdapter,
  ReviewPostResult,
  ReviewThreadInfo,
} from '../platform/adapter.js';
import type {
  ChangedFile,
  IssueComment,
  IssueContext,
  PRContext,
  ReviewComment,
  ReviewIssue,
  ReviewResult,
  VerdictMode,
} from '../types/index.js';
import { autoResolveAddressedThreads } from './auto-resolve.js';
import { CircuitBreaker, countHttpError } from './circuit-breaker.js';
import { getErrorStatus } from './errors.js';
import {
  applyNoiseBudget,
  mergeSpilloverSummaries,
  normalizeNoiseBudget,
} from './filter-findings.js';
import {
  extractFingerprintFromBody,
  filterIssuesByFingerprints,
  fingerprintForIssueFull,
  toFingerprintIdMap,
  withFingerprintMarker,
} from './inline-fingerprint.js';
import { getLabelColor } from './label-color.js';
import { withRetry } from './retry.js';
import type { RetryOptions } from './retry.js';
import { buildInlinePrelude, buildReviewBody } from './review-body.js';
import type { ReviewBodyOptions } from './review-body.js';
import { gatherReviewThread } from './review-thread.js';
import type { ThreadComment } from './review-thread.js';
import { VERDICT_FAILURE_SENTINELS, normalizeVerdictMode } from './verdict-mode.js';

/**
 * Single-flight registry for marker-based comment upserts (postOrUpdateComment).
 * Shared across GitHubHelper instances so concurrent webhook events for the same
 * issue/marker collapse onto one create-or-update instead of racing read-then-
 * write. Entries are removed when the upsert settles.
 */
const commentUpserts = new Map<
  string,
  {
    body: string;
    pendingBody?: string;
    promise: Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }>;
  }
>();

/** Paginated result wrapper for API responses. */
export interface PaginatedResult<T> {
  items: T[];
  totalCount: number;
}

/**
 * Coerce an optional fingerprint collection to a Set (fail-open: invalid
 * input yields an empty set so the dedup gate becomes a no-op).
 * @param value - Set or array of fingerprint/legacy-key strings.
 * @returns A Set of strings (possibly empty).
 * @since NEXT
 */
function toFingerprintSet(value: Set<string> | string[] | undefined): Set<string> {
  try {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) {
      // ⚡ Bolt: Use a single-pass loop instead of `.filter()` to avoid intermediate array allocation
      const set = new Set<string>();
      for (const v of value) {
        if (typeof v === 'string') set.add(v);
      }
      return set;
    }
  } catch {
    // fall through to empty set
  }
  return new Set<string>();
}

/**
 * Parse a unified diff into a set of `file:line` strings covering the
 * new-side (RIGHT) lines of each hunk. Hunk bodies are walked line by line
 * (` ` and `+` consume one new-side line; `-` consumes none) so only lines
 * that actually exist on the new side are reported.
 *
 * Fail-open fallback: when a hunk body yields fewer new-side lines than the
 * hunk header declares (truncated diff, missing body in fixtures), the full
 * header-declared range is unioned in so valid positions are never dropped —
 * the safe direction is allowing an extra comment (recovered downstream)
 * rather than silently discarding a valid finding.
 *
 * @param diffText - Raw unified diff text.
 * @returns Set of `file:line` strings for new-side lines in the diff.
 */
export function parseDiffHunkLines(diffText: string): Set<string> {
  const lines = new Set<string>();
  let currentFile = '';
  const linesArray = diffText.split('\n');
  const hunkRegex = /^@@\s+-[0-9,]+\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/;
  let hunkActive = false;
  let hunkStart = 0;
  let hunkCount = 0;
  let hunkWalked = 0;
  let newLine = 0;

  const flushHunk = (): void => {
    if (hunkActive && currentFile && hunkCount > 0 && hunkWalked < hunkCount) {
      for (let i = 0; i < hunkCount; i++) {
        lines.add(`${currentFile}:${hunkStart + i}`);
      }
    }
    hunkActive = false;
    hunkWalked = 0;
    hunkCount = 0;
  };

  for (const line of linesArray) {
    if (line.startsWith('\\')) continue;
    if (line.startsWith('Binary')) continue;

    if (line.startsWith('+++ b/')) {
      flushHunk();
      currentFile = line.substring(6).trim();
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      flushHunk();
      currentFile = '';
      continue;
    }
    if (line.startsWith('diff --git') || line.startsWith('--- ')) {
      flushHunk();
      continue;
    }
    const match = hunkRegex.exec(line);
    if (match && currentFile) {
      flushHunk();
      hunkActive = true;
      hunkStart = Number.parseInt(match[1], 10);
      hunkCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
      hunkWalked = 0;
      newLine = hunkStart;
      continue;
    }
    if (match) {
      flushHunk();
      continue;
    }
    if (!hunkActive || !currentFile) continue;
    if (line.startsWith('+')) {
      lines.add(`${currentFile}:${newLine}`);
      newLine++;
      hunkWalked++;
    } else if (line.startsWith(' ')) {
      lines.add(`${currentFile}:${newLine}`);
      newLine++;
      hunkWalked++;
    } else if (line.startsWith('-')) {
      // Deletion: consumes no new-side line.
    } else if (line === '') {
      // Blank diff line: unified diffs render an empty file line as a bare
      // empty line (context). Consume one new-side line while the hunk still
      // expects lines; the trailing split artifact past the last hunk has
      // hunkWalked >= hunkCount (or no active hunk) and is ignored.
      if (hunkWalked < hunkCount) {
        lines.add(`${currentFile}:${newLine}`);
        newLine++;
        hunkWalked++;
      }
    } else {
      // Unknown directive ends the hunk body (fail-open: header fallback applies).
      flushHunk();
    }
  }
  flushHunk();
  return lines;
}

/** Opt-in review gating mode mapped to the Pulls `createReview` event. */
export type { VerdictMode } from '../types/index.js';
export { normalizeVerdictMode } from './verdict-mode.js';

/** Review event sent on `POST /pulls/{n}/reviews`. */
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** Maximum characters GitHub accepts in a review body (fallback retries cap here). */
const GITHUB_REVIEW_BODY_LIMIT = 65535;

/**
 * Reasoning strings marking a failed (not genuine) review pass.
 * Re-exported from the shared verdict-mode module (which the review engine
 * also consumes) so gating can never drift from the engine's sentinel list.
 * @since NEXT
 */
export { VERDICT_FAILURE_SENTINELS } from './verdict-mode.js';

/**
 * Resolve the Pulls `createReview` event for a review result + gating mode.
 * Deterministic mapping (emits a `core.warning` side effect on invalid mode),
 * safe to unit test.
 *
 * - `comment` (or unset/invalid) → `COMMENT` always.
 * - `approve` → `APPROVE` only when the verdict is ready with zero
 *   critical/important findings, no partial failures, and no failure
 *   sentinel reasoning; otherwise `COMMENT`.
 * - `request-changes` → `REQUEST_CHANGES` only when critical findings are
 *   present; otherwise `COMMENT`.
 *
 * @param result - Review result to gate on.
 * @param verdictMode - Opt-in gating mode (default `'comment'`).
 * @returns The review event to send.
 * @since NEXT
 */
export function resolveReviewEvent(
  result: ReviewResult,
  verdictMode?: VerdictMode | string,
): ReviewEvent {
  const mode = normalizeVerdictMode(verdictMode);
  if (mode === 'comment') return 'COMMENT';
  // Count from the post-filter issues array (not result.stats, which was
  // computed pre-filter): suppressLowConfidence filtering and fingerprint
  // dedup remove issues without recomputing stats, so a suppressed or
  // already-posted critical must not trigger REQUEST_CHANGES (or block
  // APPROVE) for findings that will not be posted. Fall back to stats only
  // when no issues array is present.
  let critical: number;
  let important: number;
  if (Array.isArray(result?.issues)) {
    critical = 0;
    important = 0;
    for (const issue of result.issues) {
      if (issue?.severity === 'critical') critical += 1;
      else if (issue?.severity === 'important') important += 1;
    }
  } else {
    const stats = result?.stats ?? { critical: 0, important: 0 };
    critical = stats.critical ?? 0;
    important = stats.important ?? 0;
  }
  const unreliable =
    (result?.failedBatches ?? 0) > 0 ||
    (result?.failedAgents ?? 0) > 0 ||
    VERDICT_FAILURE_SENTINELS.has(result?.verdict?.reasoning ?? '');
  if (mode === 'approve') {
    if (result?.verdict?.ready !== true) return 'COMMENT';
    if (critical > 0 || important > 0) return 'COMMENT';
    if (unreliable) return 'COMMENT';
    return 'APPROVE';
  }
  // request-changes: block only on criticals from a reliable pass (fail-open
  // on failed/unreliable passes, mirroring the approve-path guard, so stale
  // critical counts never block the merge); everything else stays a comment.
  if (critical > 0) {
    if (unreliable) return 'COMMENT';
    return 'REQUEST_CHANGES';
  }
  return 'COMMENT';
}

/**
 * Pre-validate inline candidate positions against PR diff hunks.
 *
 * Splits issues into `mappable` (safe to bundle into a single
 * `POST /pulls/{n}/reviews` with a `comments[]` reviews-array) and
 * `unmappable` (must stay in the summary body so no finding is lost).
 * Key normalization (`file.replace(/^\//, '')` + `${path}:${line}`)
 * matches `buildInlineComments` and the `placedInlineKeys` filters in
 * `postReview`/`postReviewWithReviewsArray`.
 *
 * Fail-open contract: never throws. Invalid input, an unavailable/empty
 * `diffLines` set, or non-inline issues all resolve to `unmappable` (body),
 * so streaming failures never filter findings from the body.
 *
 * @param issues - Review issues to classify.
 * @param diffLines - Set of `"path:line"` keys present in the PR diff.
 * @returns Mappable vs unmappable issue lists.
 * @since NEXT
 */
export function validateInlinePositionsAgainstHunks(
  issues: ReviewIssue[],
  diffLines: Set<string>,
): { mappable: ReviewIssue[]; unmappable: ReviewIssue[] } {
  try {
    if (!Array.isArray(issues)) return { mappable: [], unmappable: [] };
    if (!(diffLines instanceof Set) || diffLines.size === 0) {
      return { mappable: [], unmappable: [...issues] };
    }
    const mappable: ReviewIssue[] = [];
    const unmappable: ReviewIssue[] = [];
    for (const issue of issues) {
      try {
        if (
          !issue ||
          issue.inline !== true ||
          typeof issue.line !== 'number' ||
          !Number.isFinite(issue.line) ||
          issue.line < 1 ||
          typeof issue.file !== 'string' ||
          issue.file.length === 0
        ) {
          unmappable.push(issue);
          continue;
        }
        const key = `${issue.file.replace(/^\//, '')}:${issue.line}`;
        if (diffLines.has(key)) mappable.push(issue);
        else unmappable.push(issue);
      } catch {
        unmappable.push(issue);
      }
    }
    return { mappable, unmappable };
  } catch {
    try {
      return { mappable: [], unmappable: Array.isArray(issues) ? [...issues] : [] };
    } catch {
      return { mappable: [], unmappable: [] };
    }
  }
}

/**
 * Information about a single review comment thread on a PR.
 */
/** Raw GraphQL response shape for a review thread node. */
interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      body: string;
      path: string;
      line: number | null;
      originalLine?: number | null;
      author: { login: string };
      createdAt: string;
      commit?: { oid?: string } | null;
      originalCommit?: { oid?: string } | null;
    }>;
  };
}

/** Raw GraphQL response for the getReviewThreads query. */
interface ReviewThreadsQueryResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ReviewThreadNode[];
      };
    };
  };
}

/**
 * Detect GraphQL schema-validation errors caused by the `commit { oid }` /
 * `originalCommit { oid }` selections on older GHES instances whose schema
 * does not expose those fields. Matched errors are safe to retry with the
 * legacy query that omits the OID selections.
 * @param err - Caught error to classify.
 * @returns True when the error is a schema-validation failure for the OID selections.
 */
function isReviewThreadCommitSchemaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!/commit/i.test(message)) return false;
  return /doesn'?t exist|does not exist|unknown field|cannot query field|was removed|no longer/i.test(
    message,
  );
}

/**
 * Resolve the severity-ordered noise budget for review posting from display
 * options (`maxVisibleFindings` wins over the `noiseBudget` alias).
 * @param options - Display options carrying the budget, if any.
 * @returns A positive integer budget, or undefined for unlimited (legacy).
 */
export function resolveNoiseBudget(options?: ReviewBodyOptions): number | undefined {
  return normalizeNoiseBudget(options?.maxVisibleFindings ?? options?.noiseBudget ?? null);
}

/**
 * Strip the noise-budget keys from display options after the caller already
 * applied the cap, so a downstream renderer does not cap (and double-count)
 * a second time.
 * @param options - Display options to strip.
 * @returns The original options when no budget is set, otherwise a copy
 * without budget keys.
 */
export function stripNoiseBudget(options?: ReviewBodyOptions): ReviewBodyOptions | undefined {
  if (options?.maxVisibleFindings === undefined && options?.noiseBudget === undefined) {
    return options;
  }
  return { ...options, maxVisibleFindings: undefined, noiseBudget: undefined };
}

/**
 * Apply the severity-ordered body noise budget to the issues left for the
 * review body, merging the incoming filter spillover with the body tail
 * itself into one spillover summary. Issues cut by the inline budget stay
 * unplaced, so they are already part of `issuesForBody` — the body tail
 * accounting subsumes them (no double counting).
 * @param base - Result carrying prior state (stats, incoming spillover).
 * @param issuesForBody - Issues not posted inline, in posting order.
 * @param options - Display options carrying the budget, if any.
 * @returns The result to render with `stripNoiseBudget(options)`.
 */
export function applyBodyNoiseBudget(
  base: ReviewResult,
  issuesForBody: ReviewIssue[],
  options?: ReviewBodyOptions,
): ReviewResult {
  const { visible, spillover: bodySpillover } = applyNoiseBudget(
    issuesForBody,
    resolveNoiseBudget(options),
  );
  const combined = mergeSpilloverSummaries(base.spillover, bodySpillover);
  const out: ReviewResult = { ...base, issues: visible };
  if (combined !== undefined) {
    out.spillover = combined;
  }
  return out;
}

/**
 * Build a deterministic Checks-run output payload carrying finding counts.
 * Pure function, safe to unit test. Counts come from the issues array (not
 * stats, which may predate confidence/dedup filtering).
 * @param result - Review result to summarize.
 * @returns Checks output `{ title, summary, text }` with stable counts.
 * @since NEXT
 */
export function buildChecksSummaryOutput(result: ReviewResult): {
  title: string;
  summary: string;
  text?: string;
} {
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  let critical = 0;
  let important = 0;
  let minor = 0;
  for (const issue of issues) {
    if (issue?.severity === 'critical') critical += 1;
    else if (issue?.severity === 'important') important += 1;
    else if (issue?.severity === 'minor') minor += 1;
  }
  const total = critical + important + minor;
  const title = `Review findings: ${critical} critical, ${important} important, ${minor} minor (${total} total)`;
  const verdict = result?.verdict?.ready === true ? 'Ready to merge: Yes' : 'Ready to merge: No';
  const summary = `${title}. ${verdict}.`;
  const text =
    issues.length === 0
      ? undefined
      : issues
          .slice(0, 50)
          .map((i) => `- ${String(i.severity ?? 'unknown').toUpperCase()}: \`${i.file}:${i.line}\``)
          .join('\n');
  return text ? { title, summary, text } : { title, summary };
}

/**
 * Helper for GitHub REST API interactions (PRs, issues, reviews, comments, labels).
 * Handles authentication, rate-limit warnings, pagination, and automatic retry
 * with exponential backoff for transient errors.
 *
 * Rate-limit handling:
 * - Logs a warning when remaining calls drop below 50.
 * - Automatically retries on 429 (rate-limited) after reading Retry-After header.
 *
 * Pagination:
 * - Uses `paginate` to fetch multi-page results with configurable per-page and max-pages.
 */
export class GitHubHelper implements PlatformAdapter {
  /**
   * @param token - GitHub personal access token (classic or fine-grained).
   * @param repo - Repository in "owner/name" format.
   * @param apiUrl - GitHub API base URL (default: https://api.github.com).
   */
  private circuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    successThreshold: 2,
    cooldownMs: 30000,
    name: 'GitHubHelper',
    // Deterministic 4xx client errors (except 429) will never recover on retry,
    // so they should not trip the circuit. 5xx and persistent 429s do.
    shouldCountFailure: countHttpError,
  });

  /**
   * @param token - GitHub personal access token.
   * @param repo - Repository in "owner/name" format.
   * @param apiUrl - GitHub API base URL (default: https://api.github.com).
   */
  constructor(
    private token: string,
    private repo: string,
    private apiUrl = 'https://api.github.com',
  ) {}

  private static readonly RATE_LIMIT_THRESHOLD = 50;

  /**
   * Per-instance cache of parsed PR diff lines keyed by PR number.
   * Entries expire after DIFF_CACHE_TTL_MS. The helper has no headSha, so
   * staleness across pushes is bounded by the short TTL; callers that need
   * strict freshness should call clearDiffLinesCache() when headSha changes.
   */
  private diffLinesCache = new Map<string, { lines: Set<string>; ts: number }>();
  private static readonly DIFF_CACHE_TTL_MS = 60_000;
  /**
   * Upper bound for diff-line entries so a long-lived helper serving many PRs
   * cannot grow the map without bound. Oldest-inserted (or expired) entries
   * are evicted on write.
   */
  private static readonly DIFF_CACHE_MAX_ENTRIES = 500;

  private async api<T>(
    path: string,
    options: RequestInit = {},
    responseType?: 'json' | 'text',
    signal?: AbortSignal,
    retryOptions: RetryOptions = {},
  ): Promise<T> {
    const url = `${this.apiUrl}/repos/${this.repo}${path}`;
    const method = (options.method ?? 'GET').toUpperCase();
    const isIdempotent =
      method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE';

    return this.circuitBreaker.call(() =>
      withRetry(
        async () => {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(new DOMException('GitHub API timed out', 'TimeoutError')),
            30_000,
          );
          const onAbort = () => controller.abort(signal?.reason);
          if (signal) {
            // Guard against the signal already being aborted in the gap between
            // withRetry's top-of-loop check and this listener registration,
            // which would otherwise leave the attempt un-cancellable.
            // Forward the caller's reason so TimeoutError vs AbortError stays
            // distinguishable downstream.
            if (signal.aborted) {
              controller.abort(signal.reason);
            } else {
              signal.addEventListener('abort', onAbort, { once: true });
            }
          }
          try {
            const attemptSignal =
              typeof AbortSignal.any === 'function'
                ? AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
                : controller.signal;
            const res = await fetch(url, {
              ...options,
              signal: attemptSignal,
              headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...options.headers,
              },
            });

            this.checkRateLimit(res);

            if (!res.ok) {
              const body = await res.text();
              const truncatedBody = body.length > 500 ? body.slice(0, 500) + '...' : body;
              const err = new Error(`GitHub API ${res.status} on ${path}: ${truncatedBody}`);
              (err as Error & { status: number }).status = res.status;
              // Attach headers so withRetry can honor a Retry-After hint on 429s.
              (err as Error & { headers?: Headers }).headers = res.headers;
              throw err;
            }

            if (res.status === 204 || method === 'HEAD') return undefined as T;
            return responseType === 'text' ? (res.text() as T) : res.json();
          } finally {
            clearTimeout(timeout);
            if (signal) {
              signal.removeEventListener('abort', onAbort);
            }
          }
        },
        {
          retryableStatuses: isIdempotent ? [429, 500, 502, 503, 504] : [429],
          retryUnknownStatus: isIdempotent,
          signal,
          ...retryOptions,
        },
      ),
    );
  }

  private checkRateLimit(res: Response): void {
    const remaining = res.headers.get('X-RateLimit-Remaining');
    const reset = res.headers.get('X-RateLimit-Reset');
    if (remaining !== null) {
      const remainingNum = Number.parseInt(remaining, 10);
      if (remainingNum <= GitHubHelper.RATE_LIMIT_THRESHOLD) {
        const resetDate = reset
          ? new Date(Number.parseInt(reset, 10) * 1000).toISOString()
          : 'unknown';
        core.warning(
          `GitHub API rate limit low: ${remainingNum} remaining (resets at ${resetDate})`,
        );
      }
    }
    // Warn once if we receive a 429 with retry-after header
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      if (retryAfter) {
        core.warning(`GitHub API rate limited — retrying after ${retryAfter}s`);
      }
    }
  }

  /**
   * Fetch paginated results from a GitHub API endpoint.
   * @param endpoint - API endpoint path (e.g. "/issues/1/comments").
   * @param options - Pagination options.
   * @param options.perPage - Items per page (default: 100).
   * @param options.maxPages - Maximum pages to fetch (default: 10).
   * @param options.direction - Sort direction (optional, e.g. 'asc' or 'desc').
   * @param options.throwOnError - When true, rethrow a page-fetch error instead of
   * silently returning partial data (default: false).
   * @param options.stopWhen - Predicate evaluated against the accumulated items after
   * each page; when it returns true, pagination stops early (default: never).
   * @param options.onTruncated - Optional hook invoked when a page fetch fails and
   * partial data is returned (only when throwOnError is false). Receives the
   * failed page number and the error so callers can log/metric the truncation.
   * When provided, the hook owns the log line and the generic truncation log
   * is demoted to debug so one event yields one warning.
   * @param signal - Optional AbortSignal to cancel the paginated fetch.
   * @returns Array of items from all pages.
   */
  public async paginate<T>(
    endpoint: string,
    options?: {
      perPage?: number;
      maxPages?: number;
      direction?: 'asc' | 'desc';
      throwOnError?: boolean;
      stopWhen?: (items: T[]) => boolean;
      onTruncated?: (page: number, err: unknown) => void;
    },
    signal?: AbortSignal,
  ): Promise<T[]> {
    const perPage = options?.perPage ?? 100;
    const maxPages = options?.maxPages ?? 10;
    const direction = options?.direction;
    const stopWhen = options?.stopWhen;
    const allItems: T[] = [];
    let page = 1;

    while (page <= maxPages) {
      const separator = endpoint.includes('?') ? '&' : '?';
      let pagePath = `${endpoint}${separator}per_page=${perPage}&page=${page}`;
      if (direction) {
        pagePath += `&direction=${direction}`;
      }
      try {
        const items = await this.api<T[]>(pagePath, {}, undefined, signal);
        allItems.push(...items);

        if (stopWhen?.(allItems)) break;
        if (items.length < perPage) break;
      } catch (err) {
        // Preserve cancellation semantics: an aborted caller signal (or an
        // AbortError from the transport) must propagate instead of being
        // downgraded to truncated partial data.
        if (
          signal?.aborted ||
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          throw err;
        }
        const truncationDetail = `Failed to fetch page ${page} for ${endpoint}: ${err instanceof Error ? err.message : err} (truncated:true, returned ${allItems.length} items from ${page - 1} pages)`;
        if (options?.throwOnError) {
          core.warning(truncationDetail);
          throw err;
        }
        try {
          options?.onTruncated?.(page, err);
        } catch {
          /* hook must never break pagination */
        }
        if (options?.onTruncated) {
          // The contextual hook owns the log line — keep one warning per event.
          core.debug(truncationDetail);
        } else {
          core.warning(truncationDetail);
        }
        break;
      }
      page++;
    }

    return allItems;
  }

  // ─── PR Operations ──────────────────────────────────────

  /**
   * Fetch a pull request's metadata and changed files.
   * Also extracts linked issue numbers from the PR body (Fixes/Closes/Resolves).
   *
   * @param number - PR number.
   * @param signal - Optional AbortSignal to cancel the underlying requests.
   * @returns PR context including title, body, branches, author, labels, and changed files.
   * @throws If the PR does not exist or the API call fails.
   */
  async getPR(number: number, signal?: AbortSignal): Promise<PRContext> {
    const [prResult, filesResult] = await Promise.allSettled([
      this.api<{
        number: number;
        title: string;
        body: string | null;
        /** 'open' | 'closed' | 'merged' (merged only when merged via the API view). */
        state: string;
        head: { ref: string; sha: string; repo?: { full_name: string } | null };
        base: { ref: string; sha?: string };
        user: { login: string };
        labels: Array<{ name: string }>;
      }>(`/pulls/${number}`, {}, undefined, signal),
      this.paginate<ChangedFile & { filename?: string }>(
        `/pulls/${number}/files`,
        {
          perPage: 100,
          maxPages: 10,
          throwOnError: true,
        },
        signal,
      ),
    ]);

    if (prResult.status === 'rejected') {
      throw prResult.reason;
    }

    const pr = prResult.value;
    if (filesResult.status === 'rejected') {
      throw filesResult.reason;
    }
    const files = filesResult.value;

    let linkedIssue: number | undefined;
    if (pr.body) {
      const match = pr.body.match(/(?:Fixes|Closes|Resolves)\s+#(\d+)/i);
      if (match) linkedIssue = Number.parseInt(match[1], 10);
    }

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      headRef: pr.head.ref,
      headRepoFullName: pr.head.repo?.full_name,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      author: pr.user.login,
      // GitHub reports PR state as 'open' | 'closed' | 'merged'. Carried
      // through so fix loops can stop pushing once a PR has been merged.
      state: pr.state,
      labels: pr.labels.map((l) => l.name),
      changedFiles: files.map((f) => ({
        path: f.filename || f.path || '',
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
      linkedIssue,
    };
  }

  /**
   * PlatformAdapter alias for getPR.
   *
   * @param number - PR number.
   * @param options - Optional error handling (throwOnError accepted for
   * interface symmetry; getPR always throws on files failure).
   * @param options.throwOnError - Accepted for interface symmetry; always throws on files failure.
   * @param signal - Optional AbortSignal to cancel the underlying requests.
   * @returns PR context including title, body, branches, author, labels, and changed files.
   */
  async getMR(
    number: number,
    options?: { throwOnError?: boolean },
    signal?: AbortSignal,
  ): Promise<PRContext> {
    void options;
    return this.getPR(number, signal);
  }

  /**
   * Check whether a given issue/PR number refers to a pull request.
   *
   * Returns false only on HTTP 404 (definitively not a PR). Rethrows
   * 401/403/429/5xx and network errors — callers must wrap in try/catch
   * and fail closed (log with status, do not fall back to the issue path).
   * @param number - Issue/PR number.
   * @returns True if the number corresponds to a pull request.
   */
  async isPR(number: number): Promise<boolean> {
    try {
      await this.api(`/pulls/${number}`, { method: 'HEAD' });
      return true;
    } catch (err) {
      const status = getErrorStatus(err);
      // Only a 404 definitively means "not a PR". Auth/rate-limit/server
      // failures must propagate so callers are not routed down the wrong path.
      if (status === 404) return false;
      throw err;
    }
  }

  /**
   * PlatformAdapter alias for isPR.
   *
   * Returns false only on HTTP 404; rethrows 401/403/429/5xx and network errors.
   * @param number - Issue/PR number.
   * @returns True if the number corresponds to a pull request.
   */
  async isMR(number: number): Promise<boolean> {
    return this.isPR(number);
  }

  /**
   * Get the repository's default branch name.
   *
   * @returns Default branch name (e.g. "main" or "master").
   */
  async getDefaultBranch(): Promise<string> {
    const repo = await this.api<{ default_branch: string }>('');
    return repo.default_branch;
  }

  // ─── Issue Operations ───────────────────────────────────

  /**
   * Fetch an issue's metadata and its comments (paginated).
   *
   * @param number - Issue number.
   * @param options - Optional error/signal handling.
   * @param options.throwOnError - When true, rethrow a comment-pagination failure
   * instead of degrading to partial comments (default: false, warn + continue).
   * @param signal - Optional AbortSignal to cancel the underlying requests.
   * @returns Issue context with title, body, labels, and comments.
   * @throws If the issue does not exist.
   */
  async getIssue(
    number: number,
    options?: { throwOnError?: boolean },
    signal?: AbortSignal,
  ): Promise<IssueContext> {
    const [issueResult, commentsResult] = await Promise.allSettled([
      this.api<{
        number: number;
        title: string;
        body: string | null;
        labels: Array<{ name: string }>;
      }>(`/issues/${number}`, {}, undefined, signal),
      this.paginate<{
        id: number;
        user: { login: string };
        created_at: string;
        body: string;
      }>(
        `/issues/${number}/comments`,
        {
          throwOnError: options?.throwOnError,
          onTruncated: options?.throwOnError
            ? undefined
            : (page, err) =>
                core.warning(
                  `getIssue(${number}): comments truncated at page ${page} — review context may be incomplete: ${err instanceof Error ? err.message : String(err)}`,
                ),
        },
        signal,
      ),
    ]);

    if (issueResult.status === 'rejected') throw issueResult.reason;

    const issue = issueResult.value;
    let comments: Array<{ id: number; user: { login: string }; created_at: string; body: string }> =
      [];
    if (commentsResult.status === 'fulfilled') {
      comments = commentsResult.value;
    } else {
      const status = getErrorStatus(commentsResult.reason);
      const suffix = status !== undefined ? ` (status ${status})` : '';
      core.warning(
        `getIssue(${number}): comments unavailable${suffix} — proceeding with partial context (truncated:true): ${commentsResult.reason instanceof Error ? commentsResult.reason.message : String(commentsResult.reason)}`,
      );
      if (options?.throwOnError) throw commentsResult.reason;
    }

    return {
      number: issue.number,
      title: issue.title,
      body: issue.body || '',
      labels: issue.labels.map((l) => l.name),
      comments: comments.map((c) => ({
        id: c.id,
        author: c.user.login,
        createdAt: c.created_at,
        body: c.body,
      })),
    };
  }

  /**
   * Fetch all comments on an issue (paginated, up to 1000 comments).
   *
   * @param number - Issue number.
   * @param options - Optional pagination options.
   * @param options.throwOnError - When true, rethrow a pagination error instead of
   * silently returning partial comments (default: false).
   * @returns Array of issue comments with author, date, and body.
   */
  async getIssueComments(
    number: number,
    options?: { throwOnError?: boolean },
  ): Promise<IssueComment[]> {
    const comments = await this.paginate<{
      id: number;
      user: { login: string };
      created_at: string;
      body: string;
    }>(`/issues/${number}/comments`, { throwOnError: options?.throwOnError });

    return comments.map((c) => ({
      id: c.id,
      author: c.user.login,
      createdAt: c.created_at,
      body: c.body,
    }));
  }

  /**
   * Get a single issue comment by its global comment ID.
   *
   * @param _issueNumber - PR/issue number (unused; GitHub issue comment IDs are global).
   * @param commentId - Issue comment ID.
   * @param signal - Optional AbortSignal to cancel the request.
   * @returns The raw issue comment object.
   */
  async getIssueComment(
    _issueNumber: number,
    commentId: number,
    signal?: AbortSignal,
  ): Promise<{ id: number; body: string; user?: { login?: string } }> {
    return this.api<{ id: number; body: string; user?: { login?: string } }>(
      `/issues/comments/${commentId}`,
      {},
      undefined,
      signal,
    );
  }

  // ─── Diff Operations ────────────────────────────────────

  /**
   * Fetch the raw diff for a PR with an explicit availability flag so callers
   * can distinguish "diff unavailable" (fetch failed: pre-validate strictly
   * and skip inline attempts) from "diff empty" (fetched fine, no new-side
   * lines: every inline position is out-of-hunk).
   *
   * Results are cached per instance keyed by PR number with a 60s TTL so
   * repeated calls within one pipeline run (e.g. per review batch) share a
   * single fetch. Pass `headSha` (e.g. the commit SHA being reviewed) so
   * entries are scoped per head; unscoped entries fall back to the short TTL.
   * Call {@link clearDiffLinesCache} when the PR head moves. Failures are
   * never cached.
   *
   * @param prNumber - PR number.
   * @param headSha - Optional head SHA scoping the cache entry.
   * @param signal - Optional AbortSignal to cancel the diff fetch.
   * @returns The parsed `file:line` set plus `failed` (true on fetch error).
   */
  async getDiffLinesWithStatus(
    prNumber: number,
    headSha?: string,
    signal?: AbortSignal,
  ): Promise<{ lines: Set<string>; failed: boolean }> {
    const cacheKey = headSha ? `${prNumber}:${headSha}` : `${prNumber}`;
    const cached = this.diffLinesCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < GitHubHelper.DIFF_CACHE_TTL_MS) {
      return { lines: new Set(cached.lines), failed: false };
    }
    try {
      const diffText = await this.api<string>(
        `/pulls/${prNumber}`,
        {
          headers: { Accept: 'application/vnd.github.v3.diff' },
        },
        'text',
        signal,
      );
      const lines = parseDiffHunkLines(diffText);
      this.setDiffLinesCache(cacheKey, lines);
      return { lines: new Set(lines), failed: false };
    } catch (err) {
      const status = getErrorStatus(err);
      const suffix = status !== undefined ? ` (status ${status})` : '';
      core.warning(`Could not fetch PR diff for line validation${suffix}: ${String(err)}`);
      return { lines: new Set(), failed: true };
    }
  }

  /**
   * Fetch the raw diff for a PR and parse it into a set of "file:line" strings
   * representing lines added/modified in the diff. Used for inline comment validation.
   *
   * Results are cached per instance keyed by PR number with a 60s TTL so
   * repeated calls within one pipeline run (e.g. per review batch) share a
   * single fetch. Pass `headSha` (e.g. the commit SHA being reviewed) so
   * entries are scoped per head; unscoped entries fall back to the short TTL.
   * Call {@link clearDiffLinesCache} when the PR head moves.
   *
   * To distinguish a failed fetch from a genuinely empty diff, prefer
   * {@link getDiffLinesWithStatus}.
   *
   * @param prNumber - PR number.
   * @param headSha - Optional head SHA scoping the cache entry.
   * @param signal - Optional AbortSignal to cancel the diff fetch.
   * @returns Set of "file:line" strings for lines in the diff.
   */
  async getDiffLines(
    prNumber: number,
    headSha?: string,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const { lines } = await this.getDiffLinesWithStatus(prNumber, headSha, signal);
    return lines;
  }

  /**
   * Invalidate cached diff lines, optionally scoped to one PR.
   * Call when the PR head SHA changes so stale line sets are not reused.
   *
   * @param prNumber - Optional PR number to invalidate; clears all when omitted.
   */
  clearDiffLinesCache(prNumber?: number): void {
    if (prNumber === undefined) {
      this.diffLinesCache.clear();
      return;
    }
    this.diffLinesCache.delete(`${prNumber}`);
    const prefix = `${prNumber}:`;
    for (const key of [...this.diffLinesCache.keys()]) {
      if (key.startsWith(prefix)) this.diffLinesCache.delete(key);
    }
  }

  /**
   * Insert into the diff-lines cache with a size bound. Refreshing an existing
   * key never evicts; otherwise expired entries are swept first and the
   * oldest-inserted entry is evicted when still at capacity.
   * @param key - Cache key (PR number, optionally suffixed with head SHA).
   * @param lines - Parsed diff lines to cache.
   */
  private setDiffLinesCache(key: string, lines: Set<string>): void {
    if (!this.diffLinesCache.has(key) && this.diffLinesCache.size > 0) {
      const now = Date.now();
      for (const [k, v] of this.diffLinesCache) {
        if (now - v.ts >= GitHubHelper.DIFF_CACHE_TTL_MS) this.diffLinesCache.delete(k);
        if (this.diffLinesCache.size < GitHubHelper.DIFF_CACHE_MAX_ENTRIES) break;
      }
      if (this.diffLinesCache.size >= GitHubHelper.DIFF_CACHE_MAX_ENTRIES) {
        const oldest = this.diffLinesCache.keys().next();
        if (!oldest.done) this.diffLinesCache.delete(oldest.value);
      }
    }
    this.diffLinesCache.set(key, { lines, ts: Date.now() });
  }

  /**
   * Fetch the raw diff between two commit SHAs on the same repository.
   * Uses the GitHub compare API (diff format).
   *
   * @param fromSha - Base commit SHA.
   * @param toSha - Head commit SHA.
   * @returns Raw diff text, or empty string on failure.
   */
  async getDiffSince(fromSha: string, toSha: string): Promise<string> {
    try {
      const diffText = await this.api<string>(
        `/compare/${fromSha}...${toSha}`,
        {
          headers: { Accept: 'application/vnd.github.v3.diff' },
        },
        'text',
      );
      return diffText;
    } catch (err) {
      core.warning(
        `Could not fetch diff between ${fromSha.slice(0, 7)} and ${toSha.slice(0, 7)}: ${String(err)}`,
      );
      return '';
    }
  }

  // ─── Comment Listing & Replies ──────────────────────────

  /**
   * List review comments on a pull request (paginated, subject to perPage/maxPages/direction options).
   *
   * @param prNumber - PR number.
   * @param options - Pagination and sort options.
   * @param options.perPage - Items per page (default: 100).
   * @param options.maxPages - Maximum pages to fetch (default: 10).
   * @param options.direction - Sort direction (optional, e.g. 'asc' or 'desc').
   * @param signal - Optional AbortSignal to cancel the paginated fetch.
   * @returns Array of raw review comment objects.
   */
  async listReviewComments(
    prNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    return this.paginate<Record<string, unknown>>(`/pulls/${prNumber}/comments`, options, signal);
  }

  /**
   * Create a reply to an existing review comment thread.
   *
   * @param prNumber - PR number.
   * @param commentId - ID of the review comment to reply to.
   * @param body - Reply body text.
   */
  async createReviewCommentReply(prNumber: number, commentId: number, body: string): Promise<void> {
    await this.api(`/pulls/${prNumber}/comments/${commentId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  /**
   * Update an existing review comment in place via `PATCH /pulls/comments/{id}`.
   * Used by the opt-in `review.updateInPlace` path to edit a matched thread
   * instead of re-posting a duplicate. Throws on API failure so callers can
   * fail open to posting a new thread as today.
   * @param commentId - Review comment ID to update.
   * @param body - New comment body markdown (must already carry the
   * fingerprint marker so future runs keep matching).
   * @param signal - Optional AbortSignal to cancel the request.
   * @since NEXT
   */
  async updateReviewComment(commentId: number, body: string, signal?: AbortSignal): Promise<void> {
    await this.api(
      `/pulls/comments/${commentId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
      undefined,
      signal,
    );
  }

  /**
   * List issue comments on a PR or issue (paginated, subject to perPage/maxPages/direction options).
   *
   * @param issueNumber - PR/issue number.
   * @param options - Pagination and sort options.
   * @param options.perPage - Items per page (default: 100).
   * @param options.maxPages - Maximum pages to fetch (default: 10).
   * @param options.direction - Sort direction (optional, e.g. 'asc' or 'desc').
   * @param options.throwOnError - When true, rethrow a page-fetch error instead of
   * silently returning partial data (default: false).
   * @param options.stopWhen - Predicate evaluated against the accumulated comments
   * after each page; when it returns true, pagination stops early (default: never).
   * @param signal - Optional AbortSignal to cancel the paginated fetch.
   * @returns Array of raw issue comment objects.
   */
  async listComments(
    issueNumber: number,
    options?: {
      perPage?: number;
      maxPages?: number;
      direction?: 'asc' | 'desc';
      throwOnError?: boolean;
      stopWhen?: (items: Array<Record<string, unknown>>) => boolean;
    },
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    return this.paginate<Record<string, unknown>>(
      `/issues/${issueNumber}/comments`,
      options,
      signal,
    );
  }

  /**
   * Post a new comment on an issue or PR.
   *
   * @param issueNumber - PR/issue number.
   * @param body - Comment body text.
   */
  async postComment(issueNumber: number, body: string): Promise<void> {
    await this.api(`/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  /**
   * Get the raw content of a file in the repository via the contents API,
   * avoiding a full pull request diff download.
   * @param _mrNumber - Merge request/PR number (unused; the contents API is
   * scoped by repo + ref instead).
   * @param filePath - Repository-relative path to the file.
   * @param ref - Optional git ref (branch, tag, or commit SHA). When omitted,
   * the default branch is used.
   * @returns Promise resolving to the file's UTF-8 content, or null when the
   * file does not exist at the given ref.
   */
  async getFileContent(_mrNumber: number, filePath: string, ref?: string): Promise<string | null> {
    const encodedPath = filePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      const content = await this.api<string>(
        `/contents/${encodedPath}${query}`,
        { headers: { Accept: 'application/vnd.github.raw' } },
        'text',
      );
      // With a raw media type, binary files (images, archives) come back as raw
      // bytes whose NUL bytes survive the UTF-8 text decode. Reject them so
      // callers fall back to the diff hunk instead of embedding binary garbage
      // in the LLM prompt.
      if (content.includes('\u0000')) return null;
      return content;
    } catch (err) {
      if (err instanceof Error && (err as Error & { status?: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }

  // ─── Review Operations ──────────────────────────────────

  /**
   * Create a check run for a commit via the Checks API. Check runs surface a
   * conclusion ('success' | 'failure' | 'neutral' | ...) that GitHub branch
   * protection can consume as a required status check.
   * @param name - Name of the check run (e.g. "OpenCode AI Reviewer").
   * @param headSha - SHA of the commit to attach the check run to.
   * @param conclusion - Check run conclusion.
   * @param output - Optional check run output.
   * @param output.title - Check run output title.
   * @param output.summary - Check run output summary.
   * @param output.text - Optional detailed output text.
   * @returns The created check run id.
   */
  async createCheckRun(
    name: string,
    headSha: string,
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required',
    output?: { title: string; summary: string; text?: string },
  ): Promise<{ id: number }> {
    return this.api<{ id: number }>('/check-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        head_sha: headSha,
        status: 'completed',
        conclusion,
        output,
      }),
    });
  }

  /**
   * Get the aggregated CI status for a commit SHA (fail-closed rollup).
   *
   * Queries `GET /commits/{sha}/check-runs` (up to 3 pages, 300 runs) plus
   * the legacy combined commit status (`GET /commits/{sha}/status`). An
   * empty rollup (`total == 0`, e.g. `[skip ci]` pushes or event-delivery
   * gaps) is returned as-is and MUST be treated as not-green by callers —
   * never synthesized to green. `skipped`/`neutral`/`cancelled` conclusions
   * are counted separately so callers can block on them (skipped !=
   * verified). When the CheckRuns `total_count` exceeds the fetched runs
   * (pagination cap hit), a pending `ci-rollup-truncated` blocker is added
   * so the rollup fails closed instead of reporting green on a partial set.
   * @param commitSha - Exact head commit SHA to query.
   * @param signal - Optional AbortSignal to cancel the requests.
   * @returns Aggregated CI status for the SHA.
   */
  async getHeadCIStatus(commitSha: string, signal?: AbortSignal): Promise<HeadCIStatus> {
    const empty: HeadCIStatus = {
      commitSha,
      total: 0,
      successful: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      green: false,
      checks: [],
    };
    if (!commitSha || commitSha.trim() === '') return empty;
    const sha = encodeURIComponent(commitSha);
    const checks: Array<{ name: string; status: string; conclusion: string }> = [];

    // CheckRuns (required — a fetch failure throws so the caller fails closed).
    // Pagination is capped at 3 pages (300 runs); truncation fails closed
    // via a pending blocker below (a missed failing check must never read green).
    const seen = new Set<string>();
    let reportedTotal: number | undefined;
    let fetchedRuns = 0;
    for (let page = 1; page <= 3; page++) {
      const res = await this.api<{
        total_count: number;
        check_runs: Array<{ name?: string; status?: string; conclusion?: string | null }>;
      }>(`/commits/${sha}/check-runs?per_page=100&page=${page}`, {}, undefined, signal);
      if (page === 1 && Number.isFinite(res?.total_count)) reportedTotal = res.total_count;
      const runs = Array.isArray(res?.check_runs) ? res.check_runs : [];
      fetchedRuns += runs.length;
      for (const run of runs) {
        const name = String(run?.name ?? 'unknown');
        const status = String(run?.status ?? 'unknown');
        const conclusion = String(run?.conclusion ?? run?.status ?? 'unknown');
        const key = `${name}\u0000${status}\u0000${conclusion}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Deduplicate identical repeats across pages only; same-named reruns
        // with different conclusions are all kept so a failed rerun is visible.
        checks.push({ name, status, conclusion });
      }
      if (runs.length < 100) break;
    }
    // Fail closed on truncation: either the API reports more runs than we
    // fetched, or the 3-page cap was hit with full pages while total_count is
    // unknown (a partial rollup must never read green).
    if (
      (reportedTotal !== undefined && reportedTotal > fetchedRuns) ||
      (reportedTotal === undefined && fetchedRuns >= 300)
    ) {
      core.warning(
        `getHeadCIStatus(${commitSha.slice(0, 7)}): check-run rollup truncated (${fetchedRuns}/${reportedTotal} fetched, 3-page cap) — treating as not green`,
      );
      checks.push({ name: 'ci-rollup-truncated', status: 'in_progress', conclusion: 'pending' });
    }

    // Legacy commit statuses (best-effort — failure warns and continues with
    // CheckRuns only; an empty status list is normal on Checks-only repos).
    try {
      const combined = await this.api<{
        state?: string;
        statuses?: Array<{ context?: string; state?: string }>;
      }>(`/commits/${sha}/status`, {}, undefined, signal);
      const statuses = Array.isArray(combined?.statuses) ? combined.statuses : [];
      for (const s of statuses) {
        const name = String(s?.context ?? 'status');
        const state = String(s?.state ?? 'pending').toLowerCase();
        if (state === 'success') {
          checks.push({ name, status: 'completed', conclusion: 'success' });
        } else if (state === 'pending') {
          checks.push({ name, status: 'pending', conclusion: 'pending' });
        } else {
          checks.push({ name, status: 'completed', conclusion: state });
        }
      }
    } catch (err) {
      core.warning(
        `getHeadCIStatus(${commitSha.slice(0, 7)}): legacy commit status unavailable — using CheckRuns only: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let successful = 0;
    let failed = 0;
    let pending = 0;
    let skipped = 0;
    for (const c of checks) {
      const status = c.status.toLowerCase();
      const conclusion = c.conclusion.toLowerCase();
      if (status !== 'completed') {
        pending += 1;
        continue;
      }
      if (conclusion === 'success') {
        successful += 1;
      } else if (
        conclusion === 'skipped' ||
        conclusion === 'neutral' ||
        conclusion === 'cancelled'
      ) {
        skipped += 1;
      } else {
        failed += 1;
      }
    }
    const total = checks.length;
    const green = total > 0 && pending === 0 && failed === 0 && skipped === 0;
    return { commitSha, total, successful, failed, pending, skipped, green, checks };
  }

  /**
   * Apply persistent fingerprint dedup to inline issues (fail-open).
   * Identical findings (same path/line/rule/snippet) already present in
   * `options.previousFingerprints` are dropped from the inline set so
   * re-pushes never re-post them; changed line/snippet yields a new
   * fingerprint and is kept. Non-inline issues always pass through.
   * @param issues - Candidate issues.
   * @param options - Display flags carrying the dedup gate + known prints.
   * @returns Deduped issues (new array; input untouched).
   * @since NEXT
   */
  private applyInlineFingerprintDedup(
    issues: ReviewIssue[],
    options?: ReviewBodyOptions,
  ): ReviewIssue[] {
    try {
      const enabled = options?.dedupFingerprints ?? true;
      if (enabled !== true) return issues;
      const previous = toFingerprintSet(options?.previousFingerprints);
      const legacy = toFingerprintSet(options?.previousInlineKeys);
      if (previous.size === 0 && legacy.size === 0) return issues;
      const inlineCandidates = issues.filter((i) => i.inline === true);
      if (inlineCandidates.length === 0) return issues;
      const { kept, skipped } = filterIssuesByFingerprints(inlineCandidates, previous, {
        enabled: true,
        legacyKeys: legacy,
      });
      if (skipped.length === 0) return issues;
      const keptSet = new Set(kept);
      core.debug(
        `Skipping ${skipped.length} duplicate inline finding(s) already posted (fingerprints)`,
      );
      return issues.filter((i) => i.inline !== true || keptSet.has(i));
    } catch (err) {
      core.warning(
        `Fingerprint dedup unavailable — posting all findings: ${err instanceof Error ? err.message : err}`,
      );
      return issues;
    }
  }

  /**
   * Embed `<!-- inline-fp -->` markers into built inline comments so future
   * runs can recognize them as already posted. Matches comments to kept
   * issues by anchor in order (fail-open: unmatched comments post as-is).
   * @param comments - Built inline comments (mutated in place).
   * @param issues - Deduped issues the comments were built from.
   * @since NEXT
   */
  private stampInlineFingerprintMarkers(
    comments: Array<{ path: string; line: number; body: string }>,
    issues: ReviewIssue[],
  ): void {
    try {
      const queueByAnchor = new Map<string, string[]>();
      for (const issue of issues) {
        if (issue.inline !== true) continue;
        let fp: string;
        try {
          fp = fingerprintForIssueFull(issue);
        } catch {
          continue;
        }
        const anchor = `${String(issue.file ?? '').replace(/^\//, '')}:${issue.line}`;
        const queue = queueByAnchor.get(anchor);
        if (queue) queue.push(fp);
        else queueByAnchor.set(anchor, [fp]);
      }
      for (const comment of comments) {
        const queue = queueByAnchor.get(`${comment.path}:${comment.line}`);
        const fp = queue?.shift();
        if (fp) comment.body = withFingerprintMarker(comment.body, fp);
      }
    } catch {
      // Fail-open: comments post without markers.
    }
  }

  /**
   * Partition stamped inline comments into in-place updates vs fresh creates
   * by matching each comment's embedded fingerprint against the known
   * fingerprint-to-commentId map. Fail-open: marker/match errors place the
   * comment in `creates` so it posts as today.
   * @param comments - Stamped inline comments.
   * @param options - Display flags carrying the update-in-place gate + map.
   * @returns `{ updates, creates }` partition (new arrays, input untouched).
   * @since NEXT
   */
  private partitionInlineCommentsForUpdate(
    comments: Array<{ path: string; line: number; side: string; body: string }>,
    options?: ReviewBodyOptions,
  ): {
    updates: Array<{ path: string; line: number; side: string; body: string; commentId: number }>;
    creates: Array<{ path: string; line: number; side: string; body: string }>;
  } {
    const creates: Array<{ path: string; line: number; side: string; body: string }> = [];
    const updates: Array<{
      path: string;
      line: number;
      side: string;
      body: string;
      commentId: number;
    }> = [];
    try {
      if (options?.updateInPlace !== true) return { updates, creates: [...comments] };
      const idByFingerprint = toFingerprintIdMap(options?.previousFingerprintCommentIds);
      if (idByFingerprint.size === 0) return { updates, creates: [...comments] };
      for (const comment of comments) {
        try {
          const fp = extractFingerprintFromBody(comment.body);
          const id = fp ? idByFingerprint.get(fp) : undefined;
          if (fp && id !== undefined) updates.push({ ...comment, commentId: id });
          else creates.push(comment);
        } catch {
          creates.push(comment);
        }
      }
      return { updates, creates };
    } catch {
      return { updates: [], creates: [...comments] };
    }
  }

  /**
   * Apply matched in-place updates via `PATCH /pulls/comments/{id}`.
   * Fail-open: each failed update warns and is returned in `failed` so the
   * caller can re-post it as a new thread as today.
   * @param updates - Matched update payloads.
   * @param signal - Optional AbortSignal.
   * @returns `{ updated, failed }` partition plus comment identity rows.
   * @since NEXT
   */
  private async applyInlineUpdates(
    updates: Array<{ path: string; line: number; side: string; body: string; commentId: number }>,
    signal?: AbortSignal,
  ): Promise<{
    updated: Array<{ file: string; line: number; commentId: number; side?: string }>;
    failed: Array<{ path: string; line: number; side: string; body: string }>;
  }> {
    const updated: Array<{ file: string; line: number; commentId: number; side?: string }> = [];
    const failed: Array<{ path: string; line: number; side: string; body: string }> = [];
    for (const update of updates) {
      signal?.throwIfAborted?.();
      try {
        await this.updateReviewComment(update.commentId, update.body, signal);
        updated.push({
          file: update.path,
          line: update.line,
          commentId: update.commentId,
          side: update.side,
        });
      } catch (err) {
        core.warning(
          `Inline update-in-place failed for comment ${update.commentId} — posting as new thread: ${err instanceof Error ? err.message : err}`,
        );
        failed.push({ path: update.path, line: update.line, side: update.side, body: update.body });
      }
    }
    if (updated.length > 0) {
      core.debug(`Updated ${updated.length} inline finding(s) in place (fingerprints)`);
    }
    return { updated, failed };
  }

  /**
   * Emit one deterministic Checks summary run when `emitChecksSummary` is
   * enabled. Fail-open: Checks API errors warn and never fail the review, and
   * no call is made when the flag is absent/false.
   * @param commitSha - Head commit SHA to attach the run to.
   * @param result - Review result to count.
   * @param options - Review body options gating the Checks summary emission.
   * @param signal - Optional AbortSignal.
   * @since NEXT
   */
  private async maybeEmitChecksSummary(
    commitSha: string,
    result: ReviewResult,
    options?: ReviewBodyOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (options?.emitChecksSummary !== true) return;
      if (!commitSha) return;
      signal?.throwIfAborted?.();
      const output = buildChecksSummaryOutput(result);
      await this.createCheckRun('OpenCode AI Reviewer', commitSha, 'success', output);
    } catch (err) {
      core.warning(
        `Checks summary unavailable — review already posted: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Auto-resolve previously posted bot threads whose fingerprinted finding no
   * longer reproduces in the fresh review (fail-open). Default enabled (absent
   * = true); `autoResolveAddressed: false` or missing `previousBotThreads`
   * disables entirely. Resolve API errors leave the thread open and never fail
   * the review. Uses the pre-dedup issue list so dedup-skipped (still-valid)
   * findings still count as present.
   * @param options - Display flags carrying the gate + prior threads.
   * @param currentIssues - Fresh review issues (pre-dedup).
   * @returns Resolved count, or undefined when disabled/nothing resolved.
   * @since NEXT
   */
  private async maybeAutoResolveAddressedThreads(
    options: ReviewBodyOptions | undefined,
    currentIssues: ReviewIssue[],
  ): Promise<number | undefined> {
    try {
      if (options?.autoResolveAddressed === false) return undefined;
      const prior = options?.previousBotThreads;
      if (!prior || prior.length === 0) return undefined;
      const resolved = await autoResolveAddressedThreads(this, prior, currentIssues);
      return resolved > 0 ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Single `POST /pulls/{n}/reviews` with fail-open permission fallback.
   *
   * Posts with the given event; when the API rejects a gated `APPROVE` or
   * `REQUEST_CHANGES` event with 403/422 (missing permission), retries once
   * as `COMMENT` (preserving the batched `comments[]` array and appending a
   * short warning suffix, truncated to the GitHub review-body limit) and
   * succeeds — the workflow step never fails on gating. A position-
   * validation 422 is rethrown so the caller retries summary-only with the
   * original event preserved.
   *
   * @param prNumber - PR number.
   * @param commitSha - Head commit SHA the review anchors to.
   * @param body - Review body markdown.
   * @param event - Review event to send.
   * @param comments - Optional inline comments array.
   * @param signal - Optional AbortSignal.
   * @returns The created review id plus any inline comment echoes.
   * @since NEXT
   */
  private async createReview<T extends { id: number }>(
    prNumber: number,
    commitSha: string,
    body: string,
    event: ReviewEvent,
    comments?: Array<{ path: string; line: number; side?: string; body: string }>,
    signal?: AbortSignal,
  ): Promise<T & { comments?: Array<{ id: number; path: string; line?: number }> }> {
    try {
      return await this.api<T & { comments?: Array<{ id: number; path: string; line?: number }> }>(
        `/pulls/${prNumber}/reviews`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commit_id: commitSha,
            event,
            body,
            ...(comments !== undefined ? { comments } : {}),
          }),
        },
        undefined,
        signal,
      );
    } catch (err) {
      const status = getErrorStatus(err);
      if (event !== 'COMMENT' && (status === 403 || status === 422)) {
        const message = err instanceof Error ? err.message : String(err);
        // Permission/event-scope rejections fall back to COMMENT; a
        // position-validation 422 on a batched comments[] payload must
        // preserve the gate — rethrow so the caller retries summary-only
        // with the original event (the summary retry itself falls back to
        // COMMENT below when it is also rejected).
        const isPermissionLike =
          status === 403 ||
          comments === undefined ||
          /permission|forbidden|not permitted|resource not accessible/i.test(message);
        if (!isPermissionLike) throw err;
        core.warning(
          `Review event ${event} rejected (status ${status}), retrying as COMMENT: ${err}`,
        );
        // Permission fallback: preserve the comments[] array so inline
        // findings ride along (both callers filter inline-mappable findings
        // out of `body`, so a body-only retry would silently discard them).
        // Cap the suffixed body at the GitHub review-body limit so a
        // near-limit body plus suffix cannot 422 on the retry. When the
        // retry itself fails (e.g. a misclassified position-422), the error
        // propagates and the caller's summary-only/per-comment fallback still
        // recovers with the gate preserved.
        const suffix = `\n\n> ⚠️ Requested review event ${event} was not permitted; posted as a comment instead.`;
        const retryBody =
          body.length + suffix.length > GITHUB_REVIEW_BODY_LIMIT
            ? `${body.slice(0, GITHUB_REVIEW_BODY_LIMIT - suffix.length - 1)}…${suffix}`
            : `${body}${suffix}`;
        return this.api<T & { comments?: Array<{ id: number; path: string; line?: number }> }>(
          `/pulls/${prNumber}/reviews`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              commit_id: commitSha,
              event: 'COMMENT',
              body: retryBody,
              ...(comments !== undefined ? { comments } : {}),
            }),
          },
          undefined,
          signal,
        );
      }
      throw err;
    }
  }

  /**
   * Post a review on a pull request with optional inline comments.
   * Posts the body first, then each inline comment individually so that
   * a single out-of-diff comment does not fail the entire review.
   * Inline comments rejected with 422 are gracefully downgraded to
   * general issue comments with a file:line reference.
   *
   * When `options.enableReviewsArrayInline` is true (opt-in, default false),
   * mappable findings are bundled into a single `POST /pulls/{n}/reviews`
   * with a `comments[]` reviews-array instead of N per-comment requests.
   * On 422/403/429 the batched request is retried once as a summary-only
   * review preserving all findings. When the flag is absent or false, the
   * legacy behavior below runs unchanged.
   *
   * @param prNumber - PR number.
   * @param commitSha - SHA of the commit to attach the review to.
   * @param result - Review result with issues and summary.
   * @param postInlineComments - Whether to attempt inline comments (default: true).
   * @param suppressLowConfidence - Whether to suppress low-confidence findings (default: false).
   * @param options - Optional display flags (e.g. deterministic function scores).
   * @param signal - Optional AbortSignal to cancel the review post.
   * @returns Object indicating success and which posting method was used.
   * @since NEXT `options.enableReviewsArrayInline` guards the reviews-array path.
   * @since NEXT `options.verdictMode` maps the verdict to the `createReview`
   * event (`comment` default, `approve`, `request-changes`) with fail-open
   * fallback to `COMMENT` on 403/422.
   */
  async postReview(
    prNumber: number,
    commitSha: string,
    result: ReviewResult,
    postInlineComments = true,
    suppressLowConfidence?: boolean,
    options?: ReviewBodyOptions,
    signal?: AbortSignal,
  ): Promise<ReviewPostResult> {
    signal?.throwIfAborted?.();
    const workingResult = suppressLowConfidence
      ? {
          ...result,
          issues: result.issues.filter((i) => i.confidence !== 'low'),
        }
      : result;

    // Persistent fingerprint dedup (default on, fail-open): drop inline
    // issues already posted in previous runs so re-pushes never re-post
    // identical findings. Skipped findings stay out of the body as well —
    // they were already reported once. When `updateInPlace` is enabled the
    // matched threads are updated instead of skipped, so dedup is bypassed
    // here and the partition below handles matched fingerprints.
    const updateInPlaceEnabled = postInlineComments && options?.updateInPlace === true;
    const dedupedResult =
      postInlineComments && !updateInPlaceEnabled && (options?.dedupFingerprints ?? true) === true
        ? {
            ...workingResult,
            issues: this.applyInlineFingerprintDedup(workingResult.issues, options),
          }
        : workingResult;

    // Additive opt-in path: single reviews-array request with fail-open
    // summary-only retry. Legacy path below runs byte-for-byte unchanged
    // when the flag is absent or false.
    if (options?.enableReviewsArrayInline === true && postInlineComments) {
      return this.postReviewWithReviewsArray(
        prNumber,
        commitSha,
        dedupedResult,
        suppressLowConfidence,
        options,
        signal,
      );
    }

    // Severity-ordered inline budget (unlimited when unset — legacy output
    // byte-identical). Issues cut here stay unplaced, so they flow into
    // issuesForBody below and remain visible via the body cap accounting.
    const builtInlineComments = postInlineComments
      ? buildInlineCommentsWithSpillover(
          dedupedResult,
          await this.getDiffLines(prNumber, commitSha, signal),
          suppressLowConfidence,
          options?.emitFixPayload,
          resolveNoiseBudget(options),
        ).comments
      : [];
    this.stampInlineFingerprintMarkers(builtInlineComments, dedupedResult.issues);

    // Opt-in update-in-place: PATCH matched threads first (fail-open: failed
    // updates fall back to fresh creates below), then post only the remaining
    // creates inline. Updated threads are excluded from the new review's
    // comments[] so no duplicate appears.
    let inlineComments = builtInlineComments;
    let updatedInline: Array<{ file: string; line: number; commentId: number; side?: string }> = [];
    if (updateInPlaceEnabled && builtInlineComments.length > 0) {
      const { updates, creates } = this.partitionInlineCommentsForUpdate(
        builtInlineComments,
        options,
      );
      if (updates.length > 0) {
        const applied = await this.applyInlineUpdates(updates, signal);
        updatedInline = applied.updated;
        inlineComments = [...applied.failed, ...creates];
      } else {
        inlineComments = creates;
      }
    }

    const placedInlineKeys = new Set<string>();
    for (const c of inlineComments) {
      placedInlineKeys.add(`${c.path}:${c.line}`);
    }
    const issuesForBody = postInlineComments
      ? dedupedResult.issues.filter(
          (i) => !i.inline || !placedInlineKeys.has(`${i.file.replace(/^\//, '')}:${i.line}`),
        )
      : dedupedResult.issues;
    const body = buildReviewBody(
      applyBodyNoiseBudget(dedupedResult, issuesForBody, options),
      stripNoiseBudget(options),
    );

    const commentIds: Array<{
      file: string;
      line: number;
      commentId: number;
      nodeId?: string;
      side?: string;
    }> = [...updatedInline];

    const updatedInlineCount = updatedInline.length;
    const withUpdatedCount = <T extends ReviewPostResult>(r: T): T =>
      updatedInlineCount > 0 ? { ...r, updatedInlineCount } : r;

    // Additive opt-in gating: resolve the createReview event from the verdict.
    // Default `comment` keeps every payload byte-identical to today.
    const reviewEvent = resolveReviewEvent(dedupedResult, options?.verdictMode);

    // Try batched review creation with inline comments included
    let reviewId: number | undefined;
    if (inlineComments.length > 0) {
      try {
        const reviewResponse = await this.createReview<{
          id: number;
          comments?: Array<{ id: number; path: string; line?: number }>;
        }>(
          prNumber,
          commitSha,
          body,
          reviewEvent,
          inlineComments.map((c) => ({
            path: c.path,
            line: c.line,
            side: c.side,
            body: c.body,
          })),
          signal,
        );
        // Extract individual comment IDs from the batched response
        if (reviewResponse.comments) {
          for (const rc of reviewResponse.comments) {
            const matched = inlineComments.find((c) => c.path === rc.path && c.line === rc.line);
            if (matched) {
              commentIds.push({
                file: rc.path,
                line: rc.line ?? matched.line,
                commentId: rc.id,
                side: matched.side,
              });
            }
          }
        }
        await this.maybeEmitChecksSummary(commitSha, dedupedResult, options, signal);
        const resolvedInlineCount = await this.maybeAutoResolveAddressedThreads(
          options,
          workingResult.issues,
        );
        return withUpdatedCount({
          success: true,
          method: 'full',
          reviewId: reviewResponse.id,
          commentIds,
          ...(resolvedInlineCount !== undefined ? { resolvedInlineCount } : {}),
        } as ReviewPostResult);
      } catch (err) {
        core.warning(`Batched review with inline comments failed: ${err}`);
        // Fall through to per-comment fallback
      }
    }

    // Fallback: post body-only review, then inline comments individually.
    // The gated event is preserved here (createReview retries as COMMENT on
    // 403/422), so a clean approve is not silently downgraded when the
    // batched request fails for a non-permission reason.
    try {
      const reviewResponse = await this.createReview<{ id: number }>(
        prNumber,
        commitSha,
        body,
        reviewEvent,
        undefined,
        signal,
      );
      reviewId = reviewResponse.id;
    } catch (err) {
      core.warning(`Body-only review failed: ${err}`);
      return { success: false, method: 'failed' };
    }

    if (inlineComments.length === 0) {
      // All inline findings were updated in place (or none existed): still
      // emit the summary review + optional Checks run so counts surface.
      await this.maybeEmitChecksSummary(commitSha, dedupedResult, options, signal);
      const resolvedInlineCount = await this.maybeAutoResolveAddressedThreads(
        options,
        workingResult.issues,
      );
      return withUpdatedCount({
        success: true,
        method: 'body-only',
        reviewId,
        ...(resolvedInlineCount !== undefined ? { resolvedInlineCount } : {}),
      });
    }

    // Post each inline comment individually with fallback
    for (const comment of inlineComments) {
      signal?.throwIfAborted?.();
      try {
        const commentResponse = await this.api<{ id: number; node_id: string }>(
          `/pulls/${prNumber}/comments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              commit_id: commitSha,
              path: comment.path,
              line: comment.line,
              side: comment.side,
              body: comment.body,
            }),
          },
          undefined,
          signal,
        );
        commentIds.push({
          file: comment.path,
          line: comment.line,
          commentId: commentResponse.id,
          nodeId: commentResponse.node_id,
          side: comment.side,
        });
      } catch (err) {
        if (err instanceof Error && (err as Error & { status: number }).status === 422) {
          const fallbackBody = buildInlinePrelude(comment.path, comment.line, comment.body);
          try {
            await this.api(
              `/issues/${prNumber}/comments`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: fallbackBody }),
              },
              undefined,
              signal,
            );
          } catch (fallbackErr) {
            core.warning(
              `Fallback comment for ${comment.path}:${comment.line} also failed: ${fallbackErr}`,
            );
          }
        } else {
          core.warning(`Inline comment for ${comment.path}:${comment.line} failed: ${err}`);
        }
      }
    }

    await this.maybeEmitChecksSummary(commitSha, dedupedResult, options, signal);
    const resolvedInlineCount = await this.maybeAutoResolveAddressedThreads(
      options,
      workingResult.issues,
    );
    return withUpdatedCount({
      success: true,
      method: 'partial',
      reviewId,
      commentIds,
      ...(resolvedInlineCount !== undefined ? { resolvedInlineCount } : {}),
    });
  }

  /**
   * Opt-in reviews-array path for {@link postReview}.
   *
   * Bundles diff-validated findings into a single `POST /pulls/{n}/reviews`
   * with the resolved gating event and a `comments[]` array (path, line, side, body).
   * Unmappable findings stay in the summary body by design. On 422 (stale or
   * out-of-range position), 403, or 429 the batch is retried once as a
   * summary-only review built from the full result so no finding is lost.
   * Never fans out to N per-comment requests.
   *
   * @param prNumber - PR number.
   * @param commitSha - Head commit SHA the review anchors to.
   * @param workingResult - Review result after confidence filtering.
   * @param suppressLowConfidence - Passed through to inline mapping.
   * @param options - Display flags (flag itself is read by the caller).
   * @param signal - Optional AbortSignal to cancel the review post.
   * @returns Review post result (`full` on batch success, `body-only` on fallback).
   * @since NEXT
   */
  private async postReviewWithReviewsArray(
    prNumber: number,
    commitSha: string,
    workingResult: ReviewResult,
    suppressLowConfidence: boolean | undefined,
    options: ReviewBodyOptions | undefined,
    signal?: AbortSignal,
  ): Promise<ReviewPostResult> {
    let diffLines: Set<string>;
    try {
      const status = await this.getDiffLinesWithStatus(prNumber, commitSha, signal);
      diffLines = status.lines;
    } catch (err) {
      core.warning(`Diff validation unavailable, posting summary-only review: ${err}`);
      diffLines = new Set<string>();
    }

    // Defense-in-depth: this entry already receives deduped input from
    // postReview, but re-apply idempotently so direct callers also dedup.
    // When `updateInPlace` is enabled the matched threads are updated instead
    // of skipped, so dedup is bypassed and the partition below handles them.
    const updateInPlaceEnabled = options?.updateInPlace === true;
    const dedupedResult = updateInPlaceEnabled
      ? workingResult
      : {
          ...workingResult,
          issues: this.applyInlineFingerprintDedup(workingResult.issues, options),
        };

    const builtInlineComments = buildInlineCommentsWithSpillover(
      dedupedResult,
      diffLines,
      suppressLowConfidence,
      options?.emitFixPayload,
      resolveNoiseBudget(options),
    ).comments;
    this.stampInlineFingerprintMarkers(builtInlineComments, dedupedResult.issues);

    // Opt-in update-in-place: PATCH matched threads first (fail-open: failed
    // updates fall back to fresh creates), then batch only the remaining
    // creates so no duplicate appears.
    let inlineComments = builtInlineComments;
    let updatedInline: Array<{ file: string; line: number; commentId: number; side?: string }> = [];
    if (updateInPlaceEnabled && builtInlineComments.length > 0) {
      const { updates, creates } = this.partitionInlineCommentsForUpdate(
        builtInlineComments,
        options,
      );
      if (updates.length > 0) {
        const applied = await this.applyInlineUpdates(updates, signal);
        updatedInline = applied.updated;
        inlineComments = [...applied.failed, ...creates];
      } else {
        inlineComments = creates;
      }
    }

    const commentIds: ReviewPostResult['commentIds'] = [...updatedInline];
    const reviewEvent = resolveReviewEvent(dedupedResult, options?.verdictMode);

    const withUpdatedCount = <T extends ReviewPostResult>(r: T): T =>
      updatedInline.length > 0 ? { ...r, updatedInlineCount: updatedInline.length } : r;

    // Full-finding body used for the fail-open summary-only retry. Lazily
    // built so the diff-unavailable early return below does not pay for it
    // twice; always built from the full deduped result so no finding is lost
    // and the gated event survives.
    let cachedFullBody: string | undefined;
    const fullBodyForSummary = (): string => {
      if (cachedFullBody === undefined) {
        cachedFullBody = buildReviewBody(dedupedResult, options);
      }
      return cachedFullBody;
    };

    const postSummaryOnly = async (event: ReviewEvent): Promise<ReviewPostResult> => {
      try {
        // Preserve the gated event via createReview so a REQUEST_CHANGES
        // block survives position-422 batch failures; createReview itself
        // falls back to COMMENT (summary-only) on 403/422 permission
        // rejections.
        const reviewResponse = await this.createReview<{ id: number }>(
          prNumber,
          commitSha,
          fullBodyForSummary(),
          event,
          undefined,
          signal,
        );
        await this.maybeEmitChecksSummary(commitSha, dedupedResult, options, signal);
        const resolvedInlineCount = await this.maybeAutoResolveAddressedThreads(
          options,
          workingResult.issues,
        );
        return withUpdatedCount({
          success: true,
          method: 'body-only',
          reviewId: reviewResponse.id,
          commentIds: commentIds.length > 0 ? commentIds : undefined,
          ...(resolvedInlineCount !== undefined ? { resolvedInlineCount } : {}),
        } as ReviewPostResult);
      } catch (err) {
        core.warning(`Summary-only review retry failed: ${err}`);
        return { success: false, method: 'failed' };
      }
    };

    // Explicit inline-hunk prevalidation (additive, guarded by the existing
    // opt-in reviews-array path): buildInlineComments already filters against
    // diffLines when available, but re-validate here so dropped positions are
    // logged and a doomed batched POST is never attempted.
    // Deterministic pre-validation (see validateInlinePositionsAgainstHunks):
    // only hunk-mappable findings ride in the single batched `comments[]`
    // request; stale/out-of-diff findings stay in the summary body.
    if (diffLines.size === 0) {
      // Diff fetch failed or the diff parsed to zero hunks: buildInlineComments
      // fail-open would otherwise post ALL inline findings as batched,
      // deterministically 422ing on stale/out-of-diff/deleted-file positions.
      // Empty-diff fail-open: without hunks every inline position would 422,
      // so skip the batched POST attempt and post summary-only directly
      // (zero extra queries when the diff is already cached — getDiffLines
      // above is the single fetch).
      core.warning('Diff validation unavailable, posting summary-only review');
      return postSummaryOnly(reviewEvent);
    }

    const validInlineComments = inlineComments.filter((c) => diffLines.has(`${c.path}:${c.line}`));
    const droppedCount = inlineComments.length - validInlineComments.length;
    if (droppedCount > 0) {
      const droppedKeys = inlineComments
        .filter((c) => !diffLines.has(`${c.path}:${c.line}`))
        .slice(0, 10)
        .map((c) => `${c.path}:${c.line}`);
      core.warning(
        `Dropped ${droppedCount} inline comment(s) outside the diff hunk range: ${droppedKeys.join(', ')}${droppedCount > droppedKeys.length ? ', …' : ''}`,
      );
      core.debug(`Inline hunk prevalidation dropped: ${droppedKeys.join(', ')}`);
    }
    if (validInlineComments.length === 0) {
      // Nothing mappable survived validation; skip the doomed batched POST
      // and post the summary-only body (all findings preserved).
      return postSummaryOnly(reviewEvent);
    }

    const placedInlineKeys = new Set<string>();
    for (const c of validInlineComments) {
      placedInlineKeys.add(`${c.path}:${c.line}`);
    }
    // Mappable findings ride inline; unmappable findings stay in the body.
    const issuesForBody = dedupedResult.issues.filter(
      (i) => !i.inline || !placedInlineKeys.has(`${i.file.replace(/^\//, '')}:${i.line}`),
    );
    const body = buildReviewBody(
      applyBodyNoiseBudget(dedupedResult, issuesForBody, options),
      stripNoiseBudget(options),
    );

    try {
      const reviewResponse = await this.createReview<{
        id: number;
        comments?: Array<{ id: number; path: string; line?: number }>;
      }>(
        prNumber,
        commitSha,
        body,
        reviewEvent,
        validInlineComments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
        signal,
      );
      if (reviewResponse.comments) {
        for (const rc of reviewResponse.comments) {
          const matched = validInlineComments.find((c) => c.path === rc.path && c.line === rc.line);
          if (matched) {
            commentIds?.push({
              file: rc.path,
              line: rc.line ?? matched.line,
              commentId: rc.id,
              side: matched.side,
            });
          }
        }
      }
      await this.maybeEmitChecksSummary(commitSha, dedupedResult, options, signal);
      const resolvedInlineCount = await this.maybeAutoResolveAddressedThreads(
        options,
        workingResult.issues,
      );
      return withUpdatedCount({
        success: true,
        method: 'full',
        reviewId: reviewResponse.id,
        commentIds,
        ...(resolvedInlineCount !== undefined ? { resolvedInlineCount } : {}),
      } as ReviewPostResult);
    } catch (err) {
      const status = getErrorStatus(err);
      // Scoped fail-open retry: only stale/validation (422), permission
      // (403), and rate-limit (429) retries go summary-only with zero
      // findings lost. All other errors (5xx, network, aborts) rethrow so
      // withRetry/CircuitBreaker own transient handling and aborts propagate.
      if (status === 422 || status === 403 || status === 429) {
        core.warning(`Reviews-array post failed (status ${status}), retrying summary-only: ${err}`);
        return postSummaryOnly(reviewEvent);
      }
      throw err;
    }
  }

  /**
   * Post a single inline review comment immediately, used by streaming reviews
   * so findings appear as each batch completes instead of after the full run.
   * Routes through `this.api()` so retry + circuit-breaker resilience applies.
   *
   * @param prNumber - PR number.
   * @param commitSha - Head commit SHA the comment anchors to.
   * @param comment - Inline comment payload.
   * @param comment.path - File path the comment anchors to.
   * @param comment.line - Diff line the comment anchors to.
   * @param comment.body - Comment body text.
   * @param comment.side - Diff side ('LEFT' or 'RIGHT'); defaults to 'RIGHT'.
   * @returns The created comment id/nodeId, or null when the post fails.
   */
  async postInlineComment(
    prNumber: number,
    commitSha: string,
    comment: {
      path: string;
      line: number;
      body: string;
      side?: 'LEFT' | 'RIGHT';
    },
  ): Promise<{ commentId: number; nodeId?: string } | null> {
    // Pre-validation against the batch's cached diff lines: when the cache
    // already holds this PR+sha and the position is absent, the POST is a
    // known-422 — skip it without an API call. Fail-open: with no cache
    // entry, POST as usual (never block streaming on an extra diff fetch).
    const cacheKeys = commitSha ? [`${prNumber}:${commitSha}`, `${prNumber}`] : [`${prNumber}`];
    for (const key of cacheKeys) {
      const entry = this.diffLinesCache.get(key);
      if (entry && Date.now() - entry.ts < GitHubHelper.DIFF_CACHE_TTL_MS) {
        if (!entry.lines.has(`${comment.path}:${comment.line}`)) {
          core.warning(
            `Skipping streaming inline comment for ${comment.path}:${comment.line}: position not in diff hunks (pre-validated, no API call).`,
          );
          return null;
        }
        break;
      }
    }
    try {
      const response = await this.api<{ id: number; node_id: string }>(
        `/pulls/${prNumber}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commit_id: commitSha,
            path: comment.path,
            line: comment.line,
            side: comment.side ?? 'RIGHT',
            body: comment.body,
          }),
        },
      );
      return { commentId: response.id, nodeId: response.node_id };
    } catch (err) {
      core.warning(
        `Streaming inline comment for ${comment.path}:${comment.line} failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * Post or update a streaming progress summary comment on a PR. Uses a stable
   * marker so repeated updates replace a single comment instead of spamming the
   * timeline.
   *
   * @param prNumber - PR number.
   * @param batchIndex - 1-based index of the batch that just completed.
   * @param totalBatches - Total number of batches.
   * @param findingCount - Number of findings posted so far.
   * @param lastFile - Optional last file reviewed (shown in the progress line).
   * @returns A promise that resolves once the progress comment is posted/updated.
   */
  async postStreamingProgress(
    prNumber: number,
    batchIndex: number,
    totalBatches: number,
    findingCount: number,
    lastFile?: string,
  ): Promise<void> {
    const body = [
      '## ⏳ Review In Progress',
      '',
      `- **Batches:** ${batchIndex}/${totalBatches} complete`,
      `- **Findings so far:** ${findingCount}`,
      ...(lastFile ? [`- **Last file:** \`${lastFile}\``] : []),
      '',
      '_Streaming review — findings are posted as they are discovered._',
    ].join('\n');
    await this.postOrUpdateComment(prNumber, '<!-- review-stream-progress -->', body);
  }

  // ─── Comment Operations ─────────────────────────────────

  /**
   * Post a new comment or update an existing one identified by a marker prefix.
   * Used for posting status updates that should not duplicate.
   *
   * @param issueNumber - Issue/PR number to comment on.
   * @param marker - Unique prefix string to identify the comment.
   * @param body - Comment body text.
   * @returns Action taken ('created' or 'updated') and the comment ID.
   */
  async postOrUpdateComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }> {
    // Single-flight per (apiUrl, repo, issue, marker): the read-then-write below
    // is not atomic, so two concurrent callers (e.g. two webhook events updating
    // the same "review in progress" marker) could both read "no marker" and both
    // POST, leaving duplicate status comments. Sharing one in-flight upsert
    // promise collapses concurrent callers onto a single create-or-update. The
    // key includes apiUrl and repo so two different providers/repositories with
    // the same issue number + marker never share (and suppress) an upsert.
    const key = `${this.apiUrl}\u0000${this.repo}\u0000${issueNumber}\u0000${marker}`;
    const existing = commentUpserts.get(key);
    if (existing) {
      // Identical in-flight work is deduplicated; a newer body for the same
      // marker is coalesced into a follow-up upsert once the first settles so
      // the newest concurrent update is eventually applied.
      if (existing.body === body) return existing.promise;
      existing.pendingBody = body;
      return existing.promise.then(async (first) => {
        const pending = existing.pendingBody;
        existing.pendingBody = undefined;
        if (pending === undefined) return first;
        return this.doPostOrUpdateComment(issueNumber, marker, pending);
      });
    }
    const entry: {
      body: string;
      pendingBody?: string;
      promise: Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }>;
    } = {
      body,
      pendingBody: undefined,
      promise: undefined as unknown as Promise<{
        action: 'created' | 'updated' | 'failed';
        commentId: number;
      }>,
    };
    entry.promise = (async () => {
      const first = await this.doPostOrUpdateComment(issueNumber, marker, body);
      const pending = entry.pendingBody;
      entry.pendingBody = undefined;
      if (pending === undefined) return first;
      return this.doPostOrUpdateComment(issueNumber, marker, pending);
    })().finally(() => {
      commentUpserts.delete(key);
    });
    commentUpserts.set(key, entry);
    return entry.promise;
  }

  private async doPostOrUpdateComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }> {
    try {
      const markedBody = `${marker}\n\n${body}`;

      const allComments = await this.paginate<{ id: number; body: string }>(
        `/issues/${issueNumber}/comments`,
        { perPage: 100, maxPages: 10, throwOnError: true },
      );

      const existing = allComments.find((c) => c.body?.startsWith(marker));

      if (existing) {
        await this.api(`/issues/comments/${existing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: markedBody }),
        });
        return { action: 'updated' as const, commentId: existing.id };
      }

      const created = await this.api<{ id: number }>(`/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: markedBody }),
      });
      return { action: 'created' as const, commentId: created.id };
    } catch (err) {
      core.warning(
        `Failed to post or update comment on issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  /**
   * Create a new comment on an issue or PR.
   *
   * @param issueNumber - Issue/PR number.
   * @param body - Comment body.
   * @returns The created comment ID.
   */
  async createComment(issueNumber: number, body: string): Promise<{ id: number }> {
    const created = await this.api<{ id: number }>(`/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return { id: created.id };
  }

  /**
   * Reply to an existing pull request review comment (threaded reply).
   * Uses POST /repos/{owner}/{repo}/pulls/{prNumber}/comments/{commentId}/replies.
   *
   * @param prNumber - PR number.
   * @param commentId - ID of the comment to reply to.
   * @param body - Reply body markdown.
   * @returns The created reply comment ID.
   */
  async replyToReviewComment(
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number }> {
    const result = await this.api<{ id: number }>(
      `/pulls/${prNumber}/comments/${commentId}/replies`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    return { id: result.id };
  }

  /**
   * Fetch a single pull request review comment by ID.
   * Uses GET /repos/{owner}/{repo}/pulls/comments/{commentId}.
   *
   * @param _mrNumber - Unused, required for PlatformAdapter compatibility.
   * @param commentId - Review comment ID.
   * @param signal - Optional AbortSignal to cancel the request.
   * @returns The review comment details.
   */
  async getReviewComment(
    _mrNumber: number,
    commentId: number,
    signal?: AbortSignal,
  ): Promise<{
    id: number;
    body: string;
    user: { login: string; type: string };
    path?: string;
    line?: number;
    in_reply_to_id?: number;
    pull_request_review_id?: number;
    diff_hunk?: string;
  }> {
    return this.api<{
      id: number;
      body: string;
      user: { login: string; type: string };
      path?: string;
      line?: number;
      in_reply_to_id?: number;
      pull_request_review_id?: number;
      diff_hunk?: string;
    }>(`/pulls/comments/${commentId}`, {}, undefined, signal);
  }

  /**
   * Fetch the full thread for a review comment by walking the in_reply_to_id chain.
   * Collects all ancestor comments from root to the given comment.
   *
   * When `prNumber` is provided the thread is reconstructed from the paginated
   * comment list in a single pass (avoiding one API call per ancestor), using
   * the shared `gatherReviewThread` helper also consumed by the conversation
   * flow so the chain-walk logic cannot drift. Without it, the chain is walked
   * with direct fetches, which is inherently sequential.
   *
   * @param commentId - The leaf comment ID to walk the thread from.
   * @param prNumber - Optional PR number used for single-pass reconstruction.
   * @param signal - Optional AbortSignal to cancel the underlying API requests.
   * @returns Thread info including ordered comments, root comment, file path, and line number.
   */
  async getReviewCommentThread(
    commentId: number,
    prNumber?: number,
    signal?: AbortSignal,
  ): Promise<{
    comments: Array<{
      id: number;
      author: string;
      body: string;
      isBot: boolean;
    }>;
    rootComment: { id: number; author: string; body: string; isBot: boolean };
    filePath: string;
    lineNumber?: number;
    commitId?: string;
  }> {
    const commentById = new Map<number, ThreadComment>();
    const chainIds: number[] = [];

    if (prNumber !== undefined) {
      // Single-pass reconstruction: fetch the paginated comment list and rebuild
      // the in_reply_to_id chain locally, eliminating one API call per ancestor.
      // The window is fetched newest-first ('desc') so recently-replied-to
      // triggers land in-window on busy PRs, reserving the by-id walk for
      // genuinely old ancestors.
      const result = await gatherReviewThread(
        this,
        prNumber,
        commentId,
        { perPage: 100, maxPages: 10, direction: 'desc' },
        signal,
      );
      for (const c of result.comments) {
        if (typeof c.id === 'number') commentById.set(c.id, c);
      }
      for (const c of result.chain) {
        if (!chainIds.includes(c.id)) chainIds.push(c.id);
      }
    } else {
      await this.walkChainById(commentId, commentById, chainIds, signal);
    }

    const comments: Array<{
      id: number;
      author: string;
      body: string;
      isBot: boolean;
    }> = [];

    let root:
      | {
          id: number;
          author: string;
          body: string;
          isBot: boolean;
        }
      | undefined;
    let filePath = '';
    let lineNumber: number | undefined;
    let commitId: string | undefined;

    // Anchor filePath/lineNumber on the ROOT comment (first chain entry) to
    // preserve the pre-refactor leaf-to-root walk semantics, falling back to the
    // first ancestor in the chain that carries them (e.g. when the root is a
    // general thread-level comment without a path/line).
    for (const id of chainIds) {
      const comment = commentById.get(id);
      if (!comment) continue;
      const entry = {
        id: comment.id,
        author: comment.user?.login ?? '',
        body: comment.body,
        isBot: comment.user?.type === 'Bot',
      };
      comments.push(entry);

      if (!filePath && comment.path) filePath = comment.path;
      if (lineNumber === undefined && comment.line !== undefined) lineNumber = comment.line;
      if (commitId === undefined && comment.commit_id) commitId = comment.commit_id;

      if (!root) root = entry;
    }

    if (!root) {
      throw new Error(`Comment ${commentId} not found — cannot build thread`);
    }

    return { comments, rootComment: root, filePath, lineNumber, commitId };
  }

  /**
   * Walk the in_reply_to_id chain from a leaf comment up to the root using
   * direct comment fetches (inherently sequential since each step depends on
   * the previous ancestor's in_reply_to_id).
   *
   * @param commentId - The leaf comment ID to start from.
   * @param commentById - Map to store fetched comments by ID.
   * @param chainIds - Array to populate with chain IDs in root-to-leaf order.
   * @param signal - Optional AbortSignal to cancel the direct-fetch walk.
   */
  private async walkChainById(
    commentId: number,
    commentById: Map<number, ThreadComment>,
    chainIds: number[],
    signal?: AbortSignal,
  ): Promise<void> {
    const discovered: number[] = [];
    let currentId: number | undefined = commentId;
    const walked = new Set<number>();
    while (currentId) {
      // Guard against cyclic/malformed in_reply_to_id chains (external data).
      if (walked.has(currentId)) break;
      walked.add(currentId);
      discovered.push(currentId);
      const comment = await this.getReviewComment(0, currentId, signal);
      commentById.set(comment.id, comment);
      currentId = comment.in_reply_to_id;
    }
    for (const id of [...discovered].reverse()) {
      if (commentById.has(id)) chainIds.push(id);
    }
  }

  /**
   * Create a new issue in the repository.
   *
   * @param title - Issue title.
   * @param body - Issue body markdown.
   * @param labels - Labels to apply.
   * @returns Object with issue number and URL, or null on failure.
   */
  async createIssue(
    title: string,
    body: string,
    labels: string[],
  ): Promise<{ number: number; url: string } | null> {
    try {
      const result = await this.api<{ number: number; html_url: string }>('/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, labels }),
      });
      return { number: result.number, url: result.html_url };
    } catch (err) {
      const status = getErrorStatus(err);
      const suffix = status !== undefined ? ` (status ${status})` : '';
      core.warning(`Failed to create issue${suffix}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Create a pull request.
   *
   * @param title - PR title.
   * @param body - PR body markdown.
   * @param head - Head branch name.
   * @param base - Base branch name.
   * @returns Object with PR number and URL, or null on failure.
   */
  async createPR(
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<{ number: number; url: string } | null> {
    try {
      const result = await this.api<{ number: number; html_url: string }>('/pulls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, head, base }),
      });
      return { number: result.number, url: result.html_url };
    } catch (err) {
      const status = getErrorStatus(err);
      const suffix = status !== undefined ? ` (status ${status})` : '';
      core.warning(
        `Failed to create PR "${title}" (${head} → ${base})${suffix}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  // ─── Label Operations ───────────────────────────────────

  /**
   * Add labels to an issue or PR (idempotent — duplicate labels are ignored).
   *
   * @param issueNumber - Issue/PR number.
   * @param labels - Labels to add.
   */
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.api(`/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels }),
    });
  }

  /**
   * Remove a label from an issue or PR. No-op if the label does not exist.
   *
   * @param issueNumber - Issue/PR number.
   * @param label - Label name to remove.
   */
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.api(`/issues/${issueNumber}/labels/${label}`, { method: 'DELETE' });
    } catch (err) {
      const status = err instanceof Error ? (err as Error & { status: number }).status : undefined;
      if (status === 404) {
        return;
      }
      core.warning(
        `Failed to remove label "${label}" on #${issueNumber}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Atomically add and remove labels in batches of 5 concurrent operations.
   *
   * @param issueNumber - Issue/PR number.
   * @param add - Labels to add.
   * @param remove - Labels to remove.
   */
  async setLabels(issueNumber: number, add: string[], remove: string[]): Promise<void> {
    const operations: Array<() => Promise<void>> = [];
    if (add.length > 0) {
      operations.push(() => this.addLabels(issueNumber, add));
    }
    for (const l of remove) {
      operations.push(() => this.removeLabel(issueNumber, l));
    }
    for (let i = 0; i < operations.length; i += 5) {
      const results = await Promise.allSettled(operations.slice(i, i + 5).map((fn) => fn()));
      for (const result of results) {
        if (result.status === 'rejected') {
          core.warning(
            `Label operation failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
    }
  }

  /**
   * Ensure a set of labels exist in the repository, creating them if missing.
   * Label colors are deterministically generated from the label name.
   *
   * @param labels - Label names to create.
   */
  async ensureLabels(labels: string[]): Promise<void> {
    const concurrency = 3;
    for (let i = 0; i < labels.length; i += concurrency) {
      await Promise.all(
        labels.slice(i, i + concurrency).map((label) =>
          this.api('/labels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: label, color: getLabelColor(label) }),
          }).catch((err) =>
            core.debug(
              `Label creation failed for "${label}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          ),
        ),
      );
    }
  }

  // ─── Context ────────────────────────────────────────────

  /**
   * Gather a rich markdown context string from an issue or PR, including
   * comments, reviews, and inline review comments (paginated).
   *
   * @param options - Context gathering options.
   * @param options.issueNumber - Optional issue number to include.
   * @param options.prNumber - Optional PR number to include.
   * @param signal - Optional AbortSignal to cancel the fan-out requests.
   * @returns Markdown string with issue/PR details, comments, and reviews.
   */
  async gatherContext(
    options: {
      issueNumber?: number;
      prNumber?: number;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const parts: string[] = [];

    // Fire all independent API fetches concurrently
    const [issue, pr, reviewComments, reviews] = await Promise.all([
      options.issueNumber
        ? this.getIssue(options.issueNumber, undefined, signal)
        : Promise.resolve(undefined),
      options.prNumber ? this.getPR(options.prNumber, signal) : Promise.resolve(undefined),
      options.prNumber
        ? this.paginate<{
            user: { login: string };
            path: string;
            line?: number;
            original_line?: number;
            body: string;
          }>(
            `/pulls/${options.prNumber}/comments`,
            {
              onTruncated: (page, err) =>
                core.warning(
                  `gatherContext(pr ${options.prNumber}): review comments truncated at page ${page} — review context may be incomplete: ${err instanceof Error ? err.message : String(err)}`,
                ),
            },
            signal,
          )
        : Promise.resolve([]),
      options.prNumber
        ? this.paginate<{ user: { login: string }; state: string; body: string }>(
            `/pulls/${options.prNumber}/reviews`,
            {
              onTruncated: (page, err) =>
                core.warning(
                  `gatherContext(pr ${options.prNumber}): reviews truncated at page ${page} — review context may be incomplete: ${err instanceof Error ? err.message : String(err)}`,
                ),
            },
            signal,
          )
        : Promise.resolve([]),
    ]);

    if (issue) {
      parts.push(`## Issue #${issue.number}`);
      parts.push('');
      parts.push(`**Title:** ${issue.title}`);
      if (issue.labels.length > 0) {
        parts.push(`**Labels:** ${issue.labels.join(', ')}`);
      }
      parts.push('');
      parts.push('### Description');
      parts.push('');
      parts.push(issue.body || 'No description.');
      parts.push('');

      if (issue.comments.length > 0) {
        parts.push('### Comments & Discussion');
        parts.push('');
        for (const c of issue.comments) {
          const bodyText = c.body || '';
          const trimmed = bodyText.trimStart();
          if (
            trimmed.startsWith('<!-- issue-analysis-plan -->') ||
            trimmed.includes('<!-- issue-analysis-plan -->')
          ) {
            const planBody = trimmed
              .replace(/^<!-- issue-analysis-plan -->\r?\n?\r?\n?/, '')
              .trim();
            parts.push('<!-- issue-analysis-plan -->');
            parts.push('### Implementation Plan (from analysis)');
            parts.push('');
            parts.push(planBody);
            parts.push('');
          } else if (
            trimmed.startsWith('<!-- issue-analysis-questions -->') ||
            trimmed.includes('<!-- issue-analysis-questions -->')
          ) {
            const questionsBody = trimmed
              .replace(/^<!-- issue-analysis-questions -->\r?\n?\r?\n?/, '')
              .trim();
            parts.push('### Analysis Questions Posed');
            parts.push('');
            parts.push(questionsBody);
            parts.push('');
          } else if (!trimmed.startsWith('<!--')) {
            parts.push(`**@${c.author}** (${c.createdAt}):`);
            parts.push(bodyText);
            parts.push('');
          }
        }
      }
    }

    if (pr) {
      parts.push(`## PR #${pr.number}`);
      parts.push('');
      parts.push(`**Title:** ${pr.title}`);
      parts.push(`**Author:** ${pr.author}`);
      parts.push('');
      parts.push('### PR Description');
      parts.push('');
      parts.push(pr.body || 'No description.');
      parts.push('');

      if (reviewComments.length > 0) {
        parts.push('### Inline Review Comments');
        parts.push('');
        for (const rc of reviewComments) {
          parts.push(`**@${rc.user?.login}** on \`${rc.path}:${rc.line || rc.original_line}\`:`);
          parts.push(rc.body || '');
          parts.push('');
        }
      }

      const substantialReviews = reviews.filter((r) => r.body && r.body.trim().length > 0);
      if (substantialReviews.length > 0) {
        parts.push('### Reviews');
        parts.push('');
        for (const r of substantialReviews) {
          parts.push(`**@${r.user?.login}** (${r.state}):`);
          parts.push(r.body || '');
          parts.push('');
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * Close all open PRs with head refs starting with "opencode/",
   * optionally filtering to those created after a given timestamp.
   *
   * @param since - ISO timestamp; only close PRs created at or after this time.
   */
  async closeOpenCodePRs(since?: string): Promise<void> {
    type PRSummary = { number: number; head: { ref: string }; created_at: string };
    const prs = await this.paginate<PRSummary>('/pulls?state=open', { perPage: 100 });
    const opencodePRs = prs.filter(
      (pr) => pr.head?.ref?.startsWith('opencode/') && (!since || pr.created_at >= since),
    );
    const concurrency = 10;
    for (let i = 0; i < opencodePRs.length; i += concurrency) {
      const results = await Promise.allSettled(
        opencodePRs.slice(i, i + concurrency).map((pr) =>
          this.api(`/pulls/${pr.number}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'closed' }),
          }).then(() => pr),
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          core.info(`Closed auto-created PR #${result.value.number} (${result.value.head.ref})`);
        } else {
          core.warning(
            `Could not close PR: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
    }
  }

  // ─── PR Merge ───────────────────────────────────────────

  /**
   * Merge a PR using the squash method.
   *
   * @param prNumber - PR number to merge.
   * @param signal - Optional AbortSignal to cancel the request.
   * @returns True if the merge succeeded.
   */
  async mergePR(prNumber: number, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.api(
        `/pulls/${prNumber}/merge`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            merge_method: 'squash',
            auto: true,
          }),
        },
        undefined,
        signal,
      );
      return true;
    } catch (err) {
      const status = getErrorStatus(err);
      const suffix = status !== undefined ? ` (status ${status})` : '';
      core.warning(
        `Failed to merge PR #${prNumber}${suffix}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /**
   * PlatformAdapter alias for mergePR.
   *
   * @param mrNumber - PR number to merge.
   * @param signal - Optional AbortSignal to cancel the request.
   * @returns True if the merge succeeded.
   */
  async mergeMR(mrNumber: number, signal?: AbortSignal): Promise<boolean> {
    return this.mergePR(mrNumber, signal);
  }

  /**
   * Enable auto-merge on a PR using squash method.
   *
   * @param prNumber - PR number.
   * @returns True if auto-merge was enabled successfully.
   */
  async enableAutoMerge(prNumber: number): Promise<boolean> {
    try {
      await this.api(`/pulls/${prNumber}/merge`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merge_method: 'squash' }),
      });
      return true;
    } catch (err) {
      const status = getErrorStatus(err);
      const suffix = status !== undefined ? ` (status ${status})` : '';
      core.warning(
        `Failed to enable auto-merge on PR #${prNumber}${suffix}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /**
   * Close an issue, optionally posting a closing comment.
   *
   * @param issueNumber - Issue number to close.
   * @param comment - Optional closing comment body.
   * @param signal - Optional AbortSignal to cancel the request.
   */
  async closeIssue(issueNumber: number, comment?: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.api(
        `/issues/${issueNumber}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: 'closed',
            ...(comment ? { state_reason: 'completed' } : {}),
          }),
        },
        undefined,
        signal,
      );
    } catch (err) {
      core.warning(
        `Failed to close issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (comment) {
      try {
        await this.api(
          `/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: comment }),
          },
          undefined,
          signal,
        );
      } catch (err) {
        core.warning(
          `Failed to post close comment on issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // ─── GraphQL Operations ─────────────────────────────────

  private get graphqlUrl(): string {
    if (this.apiUrl.includes('api.github.com')) {
      return 'https://api.github.com/graphql';
    }
    const url = new URL(this.apiUrl);
    return `${url.origin}/api/graphql`;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const execute = async (): Promise<T> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const onAbort = () => controller.abort();
      if (signal) {
        // Guard against the signal already being aborted (see api() above).
        if (signal.aborted) {
          controller.abort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      try {
        const response = await fetch(this.graphqlUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        });

        if (!response.ok) {
          const body = await response.text();
          const err = new Error(`GitHub GraphQL API ${response.status}: ${body}`);
          (err as Error & { status: number }).status = response.status;
          // Attach headers so withRetry can honor a Retry-After hint on 429s.
          (err as Error & { headers?: Headers }).headers = response.headers;
          throw err;
        }

        const result = (await response.json()) as {
          data?: T;
          errors?: Array<{ message: string }>;
        };
        if (result.errors) {
          const err = new Error(
            `GitHub GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`,
          );
          // GraphQL application-level errors (e.g. "Could not resolve to a node")
          // are deterministic and will not recover on retry. Tag them with a
          // non-retryable 4xx status so withRetry skips them, while HTTP-level
          // 429/5xx responses above still follow the normal retry policy.
          (err as Error & { status: number }).status = 422;
          throw err;
        }
        return result.data as T;
      } finally {
        clearTimeout(timeout);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      }
    };

    return this.circuitBreaker.call(() =>
      withRetry(execute, {
        // graphql() is always POST: mirror api()'s isIdempotent gating so
        // non-idempotent mutations are only retried on 429, never replayed
        // on 5xx or status-less errors.
        retryableStatuses: [429],
        retryUnknownStatus: false,
        signal,
      }),
    );
  }

  private currentUserLogin: string | null = null;
  private currentUserLoginAt = 0;
  private currentUserTokenHash: string | null = null;
  /** TTL for the cached authenticated-user login (long-lived Probot reuse). */
  private static readonly CURRENT_USER_TTL_MS = 10 * 60 * 1000;

  /**
   * Fetch the permissions the authenticated token has on the configured repository.
   * Makes a `GET /repos/{owner}/{repo}` call and returns the `permissions` object
   * (e.g. `{ admin, push, pull }`) that GitHub includes for authenticated requests.
   *
   * @returns A record of permission booleans, or null when the repository is not
   * accessible with the current token (missing repo or 403/404). Throws on
   * transport/network failures so callers can degrade gracefully.
   * @throws Error when the GitHub API is unreachable (status 0).
   */
  async getRepositoryPermissions(): Promise<Record<string, boolean> | null> {
    try {
      const repo = await this.api<{ permissions?: Record<string, boolean> }>(
        '/',
        undefined,
        undefined,
        undefined,
        // The permission probe is a pre-flight check: degrade quickly on
        // transport failures instead of burning retries/backoff.
        { maxRetries: 1, retryUnknownStatus: false },
      );
      return repo.permissions ?? null;
    } catch (err) {
      const status =
        err instanceof Error && 'status' in err ? (err as Error & { status: number }).status : 0;
      if (status === 0) {
        // Network/transport failure — rethrow so callers can distinguish this
        // from a genuine "no access" (403/404) response.
        throw err;
      }
      core.debug(
        `Failed to fetch repository permissions for ${this.repo}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Get the authenticated user's login name.
   * Falls back to GITHUB_ACTOR env var or resolves via /user and /app API endpoints.
   *
   * The login is cached per instance scoped to the token hash with a 10-minute
   * TTL so long-lived Probot helpers that rotate tokens do not reuse a stale
   * identity for bot/human thread filtering. Call {@link clearCurrentUserCache}
   * on token rotation for immediate freshness.
   *
   * @returns The login name of the authenticated user or bot.
   */
  async getCurrentUser(): Promise<string> {
    const tokenHash = GitHubHelper.hashToken(this.token);
    if (
      this.currentUserLogin &&
      this.currentUserTokenHash === tokenHash &&
      Date.now() - this.currentUserLoginAt < GitHubHelper.CURRENT_USER_TTL_MS
    ) {
      return this.currentUserLogin;
    }
    if (process.env.GITHUB_ACTOR) {
      this.currentUserLogin = process.env.GITHUB_ACTOR;
      this.currentUserLoginAt = Date.now();
      this.currentUserTokenHash = tokenHash;
      return this.currentUserLogin;
    }

    const executeUser = async (): Promise<string> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const userUrl = `${this.apiUrl}/user`;
        const userRes = await fetch(userUrl, {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (userRes.ok) {
          const user = (await userRes.json()) as { login: string };
          return user.login;
        }
        if (userRes.status === 401 || userRes.status === 403) {
          const appUrl = `${this.apiUrl}/app`;
          const appRes = await fetch(appUrl, {
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          });
          if (appRes.ok) {
            const app = (await appRes.json()) as { slug?: string; name?: string };
            const slug = app.slug || app.name?.toLowerCase().replace(/\s+/g, '-');
            if (slug) return `${slug}[bot]`;
          }
        }
        throw new Error(`Failed to resolve user/app identity: ${userRes.status}`);
      } finally {
        clearTimeout(timeout);
      }
    };

    this.currentUserLogin = await this.circuitBreaker.call(() =>
      withRetry(executeUser, { retryableStatuses: [429, 500, 502, 503, 504] }),
    );
    this.currentUserLoginAt = Date.now();
    this.currentUserTokenHash = tokenHash;
    return this.currentUserLogin;
  }

  /**
   * Clear the cached authenticated-user login (e.g. after token rotation).
   */
  clearCurrentUserCache(): void {
    this.currentUserLogin = null;
    this.currentUserLoginAt = 0;
    this.currentUserTokenHash = null;
  }

  /**
   * Non-secret hash of a token for cache scoping (never logged).
   * @param token - The token to hash.
   * @returns A short hash string identifying the token.
   */
  private static hashToken(token: string): string {
    // SHA-256 truncated to 64 bits: collision-resistant cache scoping without
    // retaining the secret itself in memory.
    return createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  /**
   * Fetch all review comment threads on a PR, including thread IDs needed
   * for GraphQL resolve mutations.
   *
   * Uses the GraphQL API since thread IDs are not available via REST.
   * Handles pagination automatically.
   *
   * @param prNumber - PR number.
   * @returns Array of review thread info objects.
   */
  async getReviewThreads(prNumber: number): Promise<ReviewThreadInfo[]> {
    const [owner, repo] = this.repo.split('/') as [string, string];
    const threads: ReviewThreadInfo[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    let pageCount = 0;
    const maxPages = 50;
    // Older GHES schemas may reject `commit { oid }` / `originalCommit { oid }`
    // on review comments. When the schema validation error is detected, fall
    // back to the legacy query without those fields (commitId degrades to
    // undefined → callers treat it as unknown and fail open).
    let useLegacyQuery = false;

    while (hasNextPage && pageCount < maxPages) {
      pageCount++;
      const buildQuery = (includeCommitOids: boolean): string => `
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage, endCursor }
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    nodes {
                      id
                      databaseId
                      body
                      path
                      line
                      originalLine
                      author { login }
                      createdAt
                      ${includeCommitOids ? 'commit { oid }\n                      originalCommit { oid }' : ''}
                    }
                  }
                }
              }
            }
          }
        }
        `;
      const variables = {
        owner,
        repo,
        number: prNumber,
        cursor,
      };
      // graphql() retries internally via withRetry (default maxRetries 3). A
      // final page failure is rethrown so getBotReviewThreads/getOpenHumanThreads
      // callers (which already guard with try/catch) know the thread data may be
      // truncated rather than silently operating on partial thread data.
      let data: ReviewThreadsQueryResponse;
      try {
        data = (await this.graphql(
          buildQuery(!useLegacyQuery),
          variables,
        )) as ReviewThreadsQueryResponse;
      } catch (err) {
        if (!useLegacyQuery && isReviewThreadCommitSchemaError(err)) {
          useLegacyQuery = true;
          core.debug(
            `getReviewThreads: commit OID fields rejected by GraphQL schema for PR #${prNumber}, falling back to legacy query`,
          );
          try {
            data = (await this.graphql(buildQuery(false), variables)) as ReviewThreadsQueryResponse;
          } catch (legacyErr) {
            core.warning(
              `Failed to fetch review thread page ${pageCount} for PR #${prNumber} — thread data may be incomplete: ${
                legacyErr instanceof Error ? legacyErr.message : legacyErr
              }`,
            );
            throw legacyErr;
          }
        } else {
          core.warning(
            `Failed to fetch review thread page ${pageCount} for PR #${prNumber} — thread data may be incomplete: ${
              err instanceof Error ? err.message : err
            }`,
          );
          throw err;
        }
      }

      const threadsData = data.repository.pullRequest.reviewThreads;
      for (const node of threadsData.nodes) {
        const comment = node.comments.nodes[0];
        if (!comment) continue;
        threads.push({
          threadId: node.id,
          isResolved: node.isResolved,
          firstComment: {
            commentId: comment.id,
            databaseId: comment.databaseId,
            body: comment.body,
            filePath: comment.path,
            lineNumber: comment.line ?? comment.originalLine ?? null,
            author: comment.author.login,
            createdAt: comment.createdAt,
            commitId: comment.commit?.oid ?? comment.originalCommit?.oid ?? undefined,
          },
        });
      }

      hasNextPage = threadsData.pageInfo.hasNextPage;
      cursor = threadsData.pageInfo.endCursor;
    }

    return threads;
  }

  /**
   * Resolve a review comment thread using a GraphQL mutation.
   *
   * @param threadId - The GraphQL node ID of the thread to resolve.
   */
  async resolveReviewThread(threadId: string): Promise<void> {
    await this.graphql(
      `
      mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { isResolved }
        }
      }
      `,
      { threadId },
    );
  }

  /**
   * Minimize (hide) a review comment using a GraphQL mutation.
   * The comment is set as minimized with the given classifier reason.
   *
   * @param commentId - The GraphQL node ID of the comment to minimize.
   * @param classifier - Reason classifier (SPAM, ABUSE, OFF_TOPIC, OUTDATED, RESOLVED, DUPLICATE).
   */
  async minimizeReviewComment(
    commentId: string,
    classifier: 'SPAM' | 'ABUSE' | 'OFF_TOPIC' | 'OUTDATED' | 'RESOLVED' | 'DUPLICATE',
  ): Promise<void> {
    await this.graphql(
      `
      mutation($commentId: ID!, $classifier: ReportedContentClassifiers!) {
        minimizeComment(input: { subjectId: $commentId, classifier: $classifier }) {
          minimizedComment { isMinimized }
        }
      }
      `,
      { commentId, classifier },
    );
  }

  /**
   * Fetch only review threads where the first comment is from the bot user
   * (the authenticated user of this GitHubHelper instance).
   *
   * @param prNumber - PR number.
   * @returns Array of review thread info objects authored by the bot.
   */
  async getBotReviewThreads(prNumber: number): Promise<ReviewThreadInfo[]> {
    const rawBotLogin = await this.getCurrentUser();
    const botLogin = rawBotLogin.toLowerCase().replace(/\[bot\]$/, '');
    const allThreads = await this.getReviewThreads(prNumber);
    return allThreads.filter((t) => {
      const author = t.firstComment.author.toLowerCase().replace(/\[bot\]$/, '');
      return author === botLogin;
    });
  }

  /**
   * List bot-authored reviews for a PR via REST `GET /pulls/{n}/reviews`,
   * newest first. Fail-open: any failure resolves to [] so callers fall back
   * to a fresh review (today's behavior).
   * @param prNumber - PR number.
   * @returns Bot review summaries ordered newest first.
   */
  async listBotReviews(prNumber: number): Promise<BotReviewInfo[]> {
    try {
      const rawBotLogin = await this.getCurrentUser();
      const botBase = rawBotLogin.toLowerCase().replace(/\[bot\]$/, '');
      const reviews = await this.paginate<Record<string, unknown>>(`/pulls/${prNumber}/reviews`, {
        perPage: 100,
        maxPages: 10,
      });
      const botReviews: BotReviewInfo[] = [];
      for (const r of reviews) {
        const login = String((r as { user?: { login?: unknown } }).user?.login ?? '').toLowerCase();
        if (login.replace(/\[bot\]$/, '') !== botBase) continue;
        const id = Number((r as { id?: unknown }).id ?? 0);
        // Zero is never a valid REST review id — skip malformed records so
        // callers taking [0] as the latest never see an id-0 stub.
        if (!Number.isFinite(id) || id <= 0) continue;
        botReviews.push({
          id,
          commitId: String((r as { commit_id?: unknown }).commit_id ?? ''),
          body: String((r as { body?: unknown }).body ?? ''),
          state: String((r as { state?: unknown }).state ?? ''),
          submittedAt: String((r as { submitted_at?: unknown }).submitted_at ?? ''),
        });
      }
      // Newest first so callers can take [0] as the latest bot review.
      botReviews.sort((a, b) => {
        if (a.submittedAt < b.submittedAt) return 1;
        if (a.submittedAt > b.submittedAt) return -1;
        return 0;
      });
      return botReviews;
    } catch (err) {
      // Preserve cancellation semantics (mirrors paginate): an aborted fetch
      // must propagate instead of degrading to [] + a fresh review LLM pass.
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (err instanceof Error && err.name === 'AbortError') throw err;
      return [];
    }
  }

  /**
   * Fetch open (unresolved) review threads authored by human reviewers.
   * Formats the threads into a markdown string for review prompt context.
   *
   * @param prNumber - PR number.
   * @returns Markdown formatted summary of open human review threads, or empty string.
   */
  async getOpenHumanThreads(prNumber: number): Promise<string> {
    const threads = await this.getReviewThreads(prNumber);
    const botLogin = await this.getCurrentUser();
    const botBase = botLogin.toLowerCase().replace(/\[bot\]$/, '');

    const openHumanThreads = threads.filter((t) => {
      if (t.isResolved) return false;
      const author = t.firstComment.author.toLowerCase().replace(/\[bot\]$/, '');
      return author !== botBase;
    });

    if (openHumanThreads.length === 0) return '';

    const lines: string[] = ['## Open Review Threads (Unresolved)', ''];
    for (const thread of openHumanThreads) {
      const fc = thread.firstComment;
      lines.push(`### Thread on \`${fc.filePath}:${fc.lineNumber ?? '?'}\``);
      lines.push(`**Author:** @${fc.author}  |  **Created:** ${fc.createdAt}`);
      lines.push('');
      lines.push(fc.body);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Update pull request metadata (title or body).
   *
   * @param prNumber - PR number.
   * @param updates - Object containing optional title and body updates.
   * @param updates.title - Optional new PR title.
   * @param updates.body - Optional new PR body.
   */
  async updatePR(prNumber: number, updates: { title?: string; body?: string }): Promise<void> {
    await this.api(`/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  }

  /**
   * PlatformAdapter alias for updatePR.
   *
   * @param mrNumber - PR number.
   * @param updates - Object containing optional title and body updates.
   * @param updates.title - Optional new PR title.
   * @param updates.body - Optional new PR body.
   * @returns A promise that resolves when the update is complete.
   */
  async updateMR(mrNumber: number, updates: { title?: string; body?: string }): Promise<void> {
    return this.updatePR(mrNumber, updates);
  }

  // ─── Changelog Operations ──────────────────────────────

  /**
   * Fetch all git tags for the repository via the matching-refs API and sort
   * them by semver (newest first), falling back to a plain descending name sort
   * for tags that do not parse as `vX.Y.Z` / `X.Y.Z`.
   *
   * @returns Array of tags with name and commit SHA, newest first.
   */
  async getTags(): Promise<Array<{ name: string; commitSha: string }>> {
    // Paginated: repos with many tags would otherwise yield a truncated list
    // and getLatestTag() could pick the wrong "latest" tag.
    const perPage = 100;
    const maxPages = 10;
    const refs = await this.paginate<{ ref: string; object: { sha: string } }>(
      '/git/matching-refs/tags',
      { perPage, maxPages, throwOnError: true },
    );
    if (refs.length >= perPage * maxPages) {
      core.warning(
        `Tag list may be truncated: reached pagination cap of ${perPage * maxPages} tags (truncated:true)`,
      );
    }
    const tags = refs.map((r) => ({
      name: r.ref.replace('refs/tags/', ''),
      commitSha: r.object.sha,
    }));
    return tags.sort((a, b) => compareSemverDesc(a.name, b.name));
  }

  /**
   * Fetch the most recent tag (by semver) for the repository.
   *
   * @returns The newest tag, or null when the repository has no tags.
   */
  async getLatestTag(): Promise<{ name: string; commitSha: string } | null> {
    const tags = await this.getTags();
    return tags[0] ?? null;
  }

  /**
   * Fetch the committer date of a commit, used to derive the changelog baseline
   * from a release tag's commit.
   *
   * @param sha - Commit SHA (or tag SHA) to look up.
   * @returns ISO 8601 committer date, or null when the commit is not found.
   */
  async getCommitDate(sha: string): Promise<string | null> {
    try {
      const commit = await this.api<{ commit: { committer: { date: string } } }>(`/commits/${sha}`);
      return commit.commit.committer.date ?? null;
    } catch (err) {
      core.warning(
        `Could not fetch commit date for ${sha.slice(0, 7)}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return null;
    }
  }

  /**
   * List pull requests merged at or after a given baseline date (paginated).
   *
   * @param since - ISO 8601 baseline date; only PRs merged at or after this are returned.
   * @param base - Optional base branch to restrict the query to (e.g. 'main').
   * @param signal - Optional AbortSignal to cancel the paginated fetch.
   * @returns Array of merged PRs sorted by update time (newest first).
   */
  async listMergedPRs(
    since: string,
    base?: string,
    signal?: AbortSignal,
  ): Promise<
    Array<{
      number: number;
      title: string;
      body: string;
      author: string;
      mergedAt: string;
      baseRef: string;
    }>
  > {
    let endpoint = '/pulls?state=closed&sort=updated&direction=desc';
    if (base) {
      endpoint += `&base=${encodeURIComponent(base)}`;
    }
    const prs = await this.paginate<{
      number: number;
      title: string;
      body: string | null;
      user: { login: string };
      merged_at: string | null;
      base: { ref: string };
    }>(endpoint, { perPage: 100, maxPages: 10 }, signal);

    return prs
      .filter((p) => p.merged_at && p.merged_at >= since)
      .map((p) => ({
        number: p.number,
        title: p.title,
        body: p.body ?? '',
        author: p.user?.login ?? 'unknown',
        mergedAt: p.merged_at as string,
        baseRef: p.base?.ref ?? '',
      }));
  }

  /**
   * Fetch the changed file paths for a pull request. Used by the changelog
   * generator's opt-in monorepo filtering (one call per merged PR).
   *
   * @param prNumber - PR number.
   * @returns Array of repo-relative file paths touched by the PR.
   */
  async getPRFilePaths(prNumber: number): Promise<string[]> {
    // Paginated (mirrors getPR()): a single page caps at 30 files and
    // downstream monorepo filters would silently miss the rest.
    const perPage = 100;
    const maxPages = 10;
    const files = await this.paginate<{ filename?: string; path?: string }>(
      `/pulls/${prNumber}/files`,
      { perPage, maxPages, throwOnError: true },
    );
    if (files.length >= perPage * maxPages) {
      core.warning(
        `PR #${prNumber} file list may be truncated: reached pagination cap of ${perPage * maxPages} files (truncated:true)`,
      );
    }
    const filePaths: string[] = [];
    for (const f of files) {
      const p = typeof f.filename === 'string' && f.filename.length > 0 ? f.filename : f.path;
      if (typeof p === 'string' && p.length > 0) filePaths.push(p);
    }
    return filePaths;
  }
}

/**
 * Compare two tag names by semver, newest first. Tags that fail to parse as
 * `v?X.Y.Z` sort after all valid semver tags (descending lexically).
 * @param a - First tag name.
 * @param b - Second tag name.
 * @returns Negative when `a` is newer than `b`, positive when older, 0 when equal.
 */
function compareSemverDesc(a: string, b: string): number {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (va && vb) {
    return vb.major - va.major || vb.minor - va.minor || vb.patch - va.patch;
  }
  if (va && !vb) return -1;
  if (!va && vb) return 1;
  return b.localeCompare(a);
}

/**
 * Parse a tag name into a `vX.Y.Z`-style semver triple, ignoring non-numeric
 * suffixes (e.g. `v1.2.3-beta.1` → `{ major: 1, minor: 2, patch: 3 }`).
 * @param tag - Tag name to parse.
 * @returns Parsed semver parts, or null when the tag has no numeric `X.Y.Z` prefix.
 */
function parseSemver(tag: string): { major: number; minor: number; patch: number } | null {
  const match = tag.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
