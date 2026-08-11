import * as core from '@actions/core';
import { buildInlineComments } from '../jsonl-parser.js';
import type { PlatformAdapter, ReviewPostResult, ReviewThreadInfo } from '../platform/adapter.js';
import type {
  ChangedFile,
  IssueComment,
  IssueContext,
  PRContext,
  ReviewComment,
  ReviewIssue,
  ReviewResult,
  ReviewStrength,
} from '../types/index.js';
import { CircuitBreaker, countHttpError } from './circuit-breaker.js';
import { getLabelColor } from './label-color.js';
import { withRetry } from './retry.js';
import type { RetryOptions } from './retry.js';
import { buildReviewBody } from './review-body.js';
import { gatherReviewThread } from './review-thread.js';
import type { ThreadComment } from './review-thread.js';

/** Paginated result wrapper for API responses. */
export interface PaginatedResult<T> {
  items: T[];
  totalCount: number;
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
          const timeout = setTimeout(() => controller.abort(), 30_000);
          const onAbort = () => controller.abort();
          if (signal) {
            // Guard against the signal already being aborted in the gap between
            // withRetry's top-of-loop check and this listener registration,
            // which would otherwise leave the attempt un-cancellable.
            if (signal.aborted) {
              controller.abort();
            } else {
              signal.addEventListener('abort', onAbort, { once: true });
            }
          }
          try {
            const res = await fetch(url, {
              ...options,
              signal: controller.signal,
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
    },
    signal?: AbortSignal,
  ): Promise<T[]> {
    const perPage = options?.perPage ?? 100;
    const maxPages = options?.maxPages ?? 10;
    const direction = options?.direction;
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

        if (items.length < perPage) break;
      } catch (err) {
        core.warning(
          `Failed to fetch page ${page} for ${endpoint}: ${err instanceof Error ? err.message : err}`,
        );
        if (options?.throwOnError) {
          throw err;
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
   * @returns PR context including title, body, branches, author, labels, and changed files.
   * @throws If the PR does not exist or the API call fails.
   */
  async getPR(number: number): Promise<PRContext> {
    const [prResult, filesResult] = await Promise.allSettled([
      this.api<{
        number: number;
        title: string;
        body: string | null;
        head: { ref: string; sha: string; repo?: { full_name: string } | null };
        base: { ref: string; sha?: string };
        user: { login: string };
        labels: Array<{ name: string }>;
      }>(`/pulls/${number}`),
      this.api<Array<ChangedFile & { filename?: string }>>(`/pulls/${number}/files`),
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
   * @returns PR context including title, body, branches, author, labels, and changed files.
   */
  async getMR(number: number): Promise<PRContext> {
    return this.getPR(number);
  }

  /**
   * Check whether a given issue/PR number refers to a pull request.
   *
   * @param number - Issue/PR number.
   * @returns True if the number corresponds to a pull request.
   */
  async isPR(number: number): Promise<boolean> {
    try {
      await this.api(`/pulls/${number}`, { method: 'HEAD' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * PlatformAdapter alias for isPR.
   *
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
   * @returns Issue context with title, body, labels, and comments.
   * @throws If the issue does not exist.
   */
  async getIssue(number: number): Promise<IssueContext> {
    const [issueResult, commentsResult] = await Promise.allSettled([
      this.api<{
        number: number;
        title: string;
        body: string | null;
        labels: Array<{ name: string }>;
      }>(`/issues/${number}`),
      this.paginate<{
        id: number;
        user: { login: string };
        created_at: string;
        body: string;
      }>(`/issues/${number}/comments`),
    ]);

    if (issueResult.status === 'rejected') throw issueResult.reason;

    const issue = issueResult.value;
    const comments = commentsResult.status === 'fulfilled' ? commentsResult.value : [];

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
   * Fetch the raw diff for a PR and parse it into a set of "file:line" strings
   * representing lines added/modified in the diff. Used for inline comment validation.
   *
   * @param prNumber - PR number.
   * @returns Set of "file:line" strings for lines in the diff.
   */
  async getDiffLines(prNumber: number): Promise<Set<string>> {
    try {
      const diffText = await this.api<string>(
        `/pulls/${prNumber}`,
        {
          headers: { Accept: 'application/vnd.github.v3.diff' },
        },
        'text',
      );
      const lines = new Set<string>();
      let currentFile = '';
      const linesArray = diffText.split('\n');
      const hunkRegex = /^@@\s+-[0-9,]+\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/;

      for (const line of linesArray) {
        if (line.startsWith('\\')) continue;
        if (line.startsWith('Binary')) continue;

        if (line.startsWith('+++ b/')) {
          currentFile = line.substring(6).trim();
        } else if (line.startsWith('+++ /dev/null')) {
          currentFile = '';
        } else {
          const match = hunkRegex.exec(line);
          if (match && currentFile) {
            const startLine = Number.parseInt(match[1], 10);
            const lineCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
            for (let i = 0; i < lineCount; i++) {
              lines.add(`${currentFile}:${startLine + i}`);
            }
          }
        }
      }
      return lines;
    } catch (err) {
      core.warning(`Could not fetch PR diff for line validation: ${String(err)}`);
      return new Set();
    }
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
   * List issue comments on a PR or issue (paginated, subject to perPage/maxPages/direction options).
   *
   * @param issueNumber - PR/issue number.
   * @param options - Pagination and sort options.
   * @param options.perPage - Items per page (default: 100).
   * @param options.maxPages - Maximum pages to fetch (default: 10).
   * @param options.direction - Sort direction (optional, e.g. 'asc' or 'desc').
   * @param signal - Optional AbortSignal to cancel the paginated fetch.
   * @returns Array of raw issue comment objects.
   */
  async listComments(
    issueNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
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
   * Post a review on a pull request with optional inline comments.
   * Posts the body first, then each inline comment individually so that
   * a single out-of-diff comment does not fail the entire review.
   * Inline comments rejected with 422 are gracefully downgraded to
   * general issue comments with a file:line reference.
   *
   * @param prNumber - PR number.
   * @param commitSha - SHA of the commit to attach the review to.
   * @param result - Review result with issues and summary.
   * @param postInlineComments - Whether to attempt inline comments (default: true).
   * @param suppressLowConfidence - Whether to suppress low-confidence findings (default: false).
   * @returns Object indicating success and which posting method was used.
   */
  async postReview(
    prNumber: number,
    commitSha: string,
    result: ReviewResult,
    postInlineComments = true,
    suppressLowConfidence?: boolean,
  ): Promise<ReviewPostResult> {
    const workingResult = suppressLowConfidence
      ? {
          ...result,
          issues: result.issues.filter((i) => i.confidence !== 'low'),
        }
      : result;

    const inlineComments = postInlineComments
      ? buildInlineComments(workingResult, await this.getDiffLines(prNumber), suppressLowConfidence)
      : [];

    const placedInlineKeys = new Set(inlineComments.map((c) => `${c.path}:${c.line}`));
    const issuesForBody = postInlineComments
      ? workingResult.issues.filter(
          (i) => !i.inline || !placedInlineKeys.has(`${i.file.replace(/^\//, '')}:${i.line}`),
        )
      : workingResult.issues;
    const body = buildReviewBody({ ...workingResult, issues: issuesForBody });

    const commentIds: Array<{
      file: string;
      line: number;
      commentId: number;
      nodeId?: string;
      side?: string;
    }> = [];

    // Try batched review creation with inline comments included
    let reviewId: number | undefined;
    if (inlineComments.length > 0) {
      try {
        const reviewResponse = await this.api<{
          id: number;
          comments?: Array<{ id: number; path: string; line?: number }>;
        }>(`/pulls/${prNumber}/reviews`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commit_id: commitSha,
            event: 'COMMENT',
            body,
            comments: inlineComments.map((c) => ({
              path: c.path,
              line: c.line,
              side: c.side,
              body: c.body,
            })),
          }),
        });
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
        return { success: true, method: 'full', reviewId: reviewResponse.id, commentIds };
      } catch (err) {
        core.warning(`Batched review with inline comments failed: ${err}`);
        // Fall through to per-comment fallback
      }
    }

    // Fallback: post body-only review, then inline comments individually
    try {
      const reviewResponse = await this.api<{ id: number }>(`/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commit_id: commitSha,
          event: 'COMMENT',
          body,
        }),
      });
      reviewId = reviewResponse.id;
    } catch (err) {
      core.warning(`Body-only review failed: ${err}`);
      return { success: false, method: 'failed' };
    }

    if (inlineComments.length === 0) {
      return { success: true, method: 'body-only', reviewId };
    }

    // Post each inline comment individually with fallback
    for (const comment of inlineComments) {
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
          const fallbackBody = `**Inline comment (${comment.path}:${comment.line})**\n\n${comment.body}`;
          try {
            await this.api(`/issues/${prNumber}/comments`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: fallbackBody }),
            });
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

    return { success: true, method: 'partial', reviewId, commentIds };
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
    try {
      const markedBody = `${marker}\n\n${body}`;

      const allComments = await this.paginate<{ id: number; body: string }>(
        `/issues/${issueNumber}/comments`,
        { perPage: 100, maxPages: 5, throwOnError: true },
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

      if (!root) root = entry;
    }

    if (!root) {
      throw new Error(`Comment ${commentId} not found — cannot build thread`);
    }

    return { comments, rootComment: root, filePath, lineNumber };
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
      core.warning(`Failed to create issue: ${err instanceof Error ? err.message : err}`);
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
      core.warning(
        `Failed to create PR "${title}" (${head} → ${base}): ${err instanceof Error ? err.message : err}`,
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
   * @returns Markdown string with issue/PR details, comments, and reviews.
   */
  async gatherContext(options: {
    issueNumber?: number;
    prNumber?: number;
  }): Promise<string> {
    const parts: string[] = [];

    // Fire all independent API fetches concurrently
    const [issue, pr, reviewComments, reviews] = await Promise.all([
      options.issueNumber ? this.getIssue(options.issueNumber) : Promise.resolve(undefined),
      options.prNumber ? this.getPR(options.prNumber) : Promise.resolve(undefined),
      options.prNumber
        ? this.paginate<{
            user: { login: string };
            path: string;
            line?: number;
            original_line?: number;
            body: string;
          }>(`/pulls/${options.prNumber}/comments`)
        : Promise.resolve([]),
      options.prNumber
        ? this.paginate<{ user: { login: string }; state: string; body: string }>(
            `/pulls/${options.prNumber}/reviews`,
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
   * @returns True if the merge succeeded.
   */
  async mergePR(prNumber: number): Promise<boolean> {
    try {
      await this.api(`/pulls/${prNumber}/merge`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merge_method: 'squash',
          auto: true,
        }),
      });
      return true;
    } catch (err) {
      core.warning(`Failed to merge PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * PlatformAdapter alias for mergePR.
   *
   * @param mrNumber - PR number to merge.
   * @returns True if the merge succeeded.
   */
  async mergeMR(mrNumber: number): Promise<boolean> {
    return this.mergePR(mrNumber);
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
      core.warning(
        `Failed to enable auto-merge on PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /**
   * Close an issue, optionally posting a closing comment.
   *
   * @param issueNumber - Issue number to close.
   * @param comment - Optional closing comment body.
   */
  async closeIssue(issueNumber: number, comment?: string): Promise<void> {
    try {
      await this.api(`/issues/${issueNumber}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: 'closed',
          ...(comment ? { state_reason: 'completed' } : {}),
        }),
      });
    } catch (err) {
      core.warning(
        `Failed to close issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (comment) {
      try {
        await this.api(`/issues/${issueNumber}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: comment }),
        });
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
          throw new Error(`GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`);
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
        retryableStatuses: [429, 500, 502, 503, 504],
        retryUnknownStatus: true,
        signal,
      }),
    );
  }

  private currentUserLogin: string | null = null;

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
   * @returns The login name of the authenticated user or bot.
   */
  async getCurrentUser(): Promise<string> {
    if (this.currentUserLogin) return this.currentUserLogin;
    if (process.env.GITHUB_ACTOR) {
      this.currentUserLogin = process.env.GITHUB_ACTOR;
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
    return this.currentUserLogin;
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

    while (hasNextPage && pageCount < maxPages) {
      pageCount++;
      const query = `
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
                    }
                  }
                }
              }
            }
          }
        }
        `;
      // graphql() retries internally via withRetry (default maxRetries 3). A
      // final page failure is rethrown so getBotReviewThreads/getOpenHumanThreads
      // callers (which already guard with try/catch) know the thread data may be
      // truncated rather than silently operating on partial thread data.
      let data: ReviewThreadsQueryResponse;
      try {
        data = (await this.graphql(query, {
          owner,
          repo,
          number: prNumber,
          cursor,
        })) as ReviewThreadsQueryResponse;
      } catch (err) {
        core.warning(
          `Failed to fetch review thread page ${pageCount} for PR #${prNumber} — thread data may be incomplete: ${
            err instanceof Error ? err.message : err
          }`,
        );
        throw err;
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
    const refs =
      await this.api<Array<{ ref: string; object: { sha: string } }>>('/git/matching-refs/tags');
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
    const files = await this.api<Array<{ filename: string }>>(`/pulls/${prNumber}/files`);
    return files.map((f) => f.filename).filter((f): f is string => typeof f === 'string');
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
