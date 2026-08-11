import * as core from '@actions/core';
import { buildInlineComments } from '../jsonl-parser.js';
import type {
  PlatformAdapter,
  ReviewCommentDetail,
  ReviewCommentThread,
  ReviewPostResult,
  ReviewThreadInfo,
} from '../platform/adapter.js';
import type {
  ChangedFile,
  IssueComment,
  IssueContext,
  PRContext,
  ReviewResult,
} from '../types/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { getLabelColor } from './label-color.js';
import { withRetry } from './retry.js';
import { buildReviewBody } from './review-body.js';

/**
 * Single-flight registry for marker-based comment upserts (postOrUpdateComment),
 * shared across GitLabAdapter instances so concurrent webhook events collapse
 * onto one create-or-update instead of racing read-then-write.
 */
const commentUpserts = new Map<
  string,
  {
    body: string;
    pendingBody?: string;
    promise: Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }>;
  }
>();

/** GitLab adapter. */
export class GitLabAdapter implements PlatformAdapter {
  private circuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    successThreshold: 2,
    cooldownMs: 30000,
    name: 'GitLabAdapter',
  });

  private currentUserLogin: string | null = null;

  /**
   * Constructor.
   * @param token
   * @param repo
   * @param apiUrl - apiUrl argument.
   * @returns Description.
   */
  constructor(
    private token: string,
    private repo: string,
    private apiUrl = 'https://gitlab.com/api/v4',
  ) {}

  private get projectPath(): string {
    return encodeURIComponent(this.repo);
  }

  private async api<T>(
    path: string,
    options: RequestInit = {},
    responseType?: 'json' | 'text',
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.apiUrl}/projects/${this.projectPath}${path}`;
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
            // withRetry's top-of-loop check and this listener registration.
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
                'PRIVATE-TOKEN': this.token,
                Accept: 'application/json',
                ...options.headers,
              },
            });

            this.checkRateLimit(res);

            if (!res.ok) {
              const body = await res.text();
              const truncatedBody = body.length > 500 ? body.slice(0, 500) + '...' : body;
              const err = new Error(`GitLab API ${res.status} on ${path}: ${truncatedBody}`);
              (err as Error & { status: number }).status = res.status;
              // Preserve response headers so withRetry can honor Retry-After hints.
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
        },
      ),
    );
  }

  private checkRateLimit(res: Response): void {
    const remaining = res.headers.get('RateLimit-Remaining');
    const reset = res.headers.get('RateLimit-Reset');
    if (remaining !== null) {
      const remainingNum = Number.parseInt(remaining, 10);
      if (remainingNum <= 50) {
        const resetDate = reset
          ? new Date(Number.parseInt(reset, 10) * 1000).toISOString()
          : 'unknown';
        core.warning(
          `GitLab API rate limit low: ${remainingNum} remaining (resets at ${resetDate})`,
        );
      }
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      if (retryAfter) {
        core.warning(`GitLab API rate limited — retrying after ${retryAfter}s`);
      }
    }
  }

  /**
   * Paginate through GitLab API endpoints.
   * @param endpoint
   * @param options
   * @param options.perPage
   * @param options.maxPages
   * @param options.direction - options.direction argument.
   * @param options.throwOnError - When true, rethrow a page-fetch error instead of
   * silently returning partial data (default: false).
   * @param signal - Optional AbortSignal to cancel the paginated fetch.
   * @returns Description.
   */
  async paginate<T>(
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
    const allItems: T[] = [];
    let page = 1;

    while (page <= maxPages) {
      const separator = endpoint.includes('?') ? '&' : '?';
      let pagePath = `${endpoint}${separator}per_page=${perPage}&page=${page}`;
      // GitLab ignores GitHub's `direction` query param; order_by/sort must be
      // set explicitly so the 'asc' assumptions in callers hold on both platforms
      // (GitLab returns notes newest-first by default).
      if (options?.direction) {
        pagePath += `&order_by=created_at&sort=${options.direction}`;
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

  // ─── MR Operations ──────────────────────────────────────

  /**
   * Get MR.
   * @param number - number argument.
   * @returns Description.
   */
  async getMR(number: number): Promise<PRContext> {
    const [mrResult, changesResult] = await Promise.allSettled([
      this.api<{
        iid: number;
        title: string;
        description: string | null;
        source_branch: string;
        sha: string;
        target_branch: string;
        source_project?: { path_with_namespace?: string } | null;
        author: { username: string };
        labels: string[];
      }>(`/merge_requests/${number}`),
      this.api<{
        changes: Array<{
          new_path: string;
          old_path: string;
          new_file: boolean;
          renamed_file: boolean;
          deleted_file: boolean;
          diff: string;
        }>;
      }>(`/merge_requests/${number}/changes`),
    ]);

    if (mrResult.status === 'rejected') {
      throw mrResult.reason;
    }

    const mr = mrResult.value;
    const changes = changesResult.status === 'fulfilled' ? changesResult.value.changes : [];

    let linkedIssue: number | undefined;
    if (mr.description) {
      const match = mr.description.match(/(?:Fixes|Closes|Resolves)\s+#(\d+)/i);
      if (match) linkedIssue = Number.parseInt(match[1], 10);
    }

    return {
      number: mr.iid,
      title: mr.title,
      body: mr.description || '',
      headRef: mr.source_branch,
      headRepoFullName: mr.source_project?.path_with_namespace,
      headSha: mr.sha,
      baseRef: mr.target_branch,
      author: mr.author.username,
      labels: mr.labels || [],
      changedFiles: changes.map((f) => ({
        path: f.new_path,
        status: f.deleted_file
          ? ('removed' as const)
          : f.new_file
            ? ('added' as const)
            : f.renamed_file
              ? ('renamed' as const)
              : ('modified' as const),
        additions: f.diff ? (f.diff.match(/^\+[^+]/gm) || []).length : 0,
        deletions: f.diff ? (f.diff.match(/^-[^-]/gm) || []).length : 0,
        patch: f.diff,
      })),
      linkedIssue,
    };
  }

  /**
   * Check if MR exists.
   * @param number - number argument.
   * @returns Description.
   */
  async isMR(number: number): Promise<boolean> {
    try {
      await this.api(`/merge_requests/${number}`, { method: 'HEAD' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get default branch.
   * @returns Default branch name.
   */
  async getDefaultBranch(): Promise<string> {
    const project = await this.api<{ default_branch: string }>('');
    return project.default_branch;
  }

  // ─── Issue Operations ───────────────────────────────────

  /**
   * Get issue.
   * @param number - number argument.
   * @returns Description.
   */
  async getIssue(number: number): Promise<IssueContext> {
    const [issueResult, commentsResult] = await Promise.allSettled([
      this.api<{
        iid: number;
        title: string;
        description: string | null;
        labels: string[];
      }>(`/issues/${number}`),
      this.paginate<{
        id: number;
        author: { username: string };
        created_at: string;
        body: string;
      }>(`/issues/${number}/notes`),
    ]);

    if (issueResult.status === 'rejected') throw issueResult.reason;

    const issue = issueResult.value;
    const comments = commentsResult.status === 'fulfilled' ? commentsResult.value : [];

    return {
      number: issue.iid,
      title: issue.title,
      body: issue.description || '',
      labels: issue.labels || [],
      comments: comments.map((c) => ({
        id: c.id,
        author: c.author.username,
        createdAt: c.created_at,
        body: c.body,
      })),
    };
  }

  /**
   * Get issue comments.
   * @param number - number argument.
   * @param options - Optional pagination options.
   * @param options.throwOnError - When true, rethrow a pagination error instead of
   * silently returning partial comments (default: false).
   * @returns Description.
   */
  async getIssueComments(
    number: number,
    options?: { throwOnError?: boolean },
  ): Promise<IssueComment[]> {
    const comments = await this.paginate<{
      id: number;
      author: { username: string };
      created_at: string;
      body: string;
    }>(`/issues/${number}/notes`, { throwOnError: options?.throwOnError });

    return comments.map((c) => ({
      id: c.id,
      author: c.author.username,
      createdAt: c.created_at,
      body: c.body,
    }));
  }

  // ─── Diff Operations ────────────────────────────────────

  /**
   * Get diff lines.
   * @param mrNumber - mrNumber argument.
   * @returns Description.
   */
  async getDiffLines(mrNumber: number): Promise<Set<string>> {
    try {
      const diffText = await this.api<string>(
        `/merge_requests/${mrNumber}/diff`,
        { headers: { Accept: 'text/plain' } },
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
      core.warning(`Could not fetch MR diff for line validation: ${String(err)}`);
      return new Set();
    }
  }

  /**
   * Get diff since SHA.
   * @param fromSha
   * @param toSha - toSha argument.
   * @returns Description.
   */
  async getDiffSince(fromSha: string, toSha: string): Promise<string> {
    try {
      /** Compare response type. */
      type CompareResponse = { diffs: Array<{ diff: string }> };
      const data = await this.api<CompareResponse>(
        `/repository/compare?from=${fromSha}&to=${toSha}`,
        { headers: { Accept: 'application/json' } },
        'json',
      );
      return (data.diffs || []).map((d) => d.diff).join('\n');
    } catch (err) {
      core.warning(
        `Could not fetch diff between ${fromSha.slice(0, 7)} and ${toSha.slice(0, 7)}: ${String(err)}`,
      );
      return '';
    }
  }

  // ─── Comment Listing & Replies ──────────────────────────

  /**
   * List review comments.
   * @param mrNumber
   * @param options
   * @param options.perPage
   * @param options.maxPages
   * @param options.direction - options.direction argument.
   * @param signal - Optional AbortSignal to cancel the paginated fetch.
   * @returns Description.
   */
  async listReviewComments(
    mrNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    return this.paginate<Record<string, unknown>>(
      `/merge_requests/${mrNumber}/notes`,
      options,
      signal,
    );
  }

  /**
   * Create review comment reply.
   * @param mrNumber
   * @param commentId
   * @param body - body argument.
   * @returns Description.
   */
  async createReviewCommentReply(mrNumber: number, commentId: number, body: string): Promise<void> {
    const discussion = await this.api<{ discussion_id?: string }>(
      `/merge_requests/${mrNumber}/notes/${commentId}`,
    );
    const discussionId = discussion?.discussion_id || String(commentId);
    await this.api(`/merge_requests/${mrNumber}/discussions/${discussionId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  /**
   * List comments.
   * @param issueNumber
   * @param options
   * @param options.perPage
   * @param options.maxPages
   * @param options.direction - options.direction argument.
   * @param signal - Optional AbortSignal to cancel the paginated fetch.
   * @returns Description.
   */
  async listComments(
    issueNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    return this.paginate<Record<string, unknown>>(`/issues/${issueNumber}/notes`, options, signal);
  }

  /**
   * Post comment.
   * @param issueNumber
   * @param body - body argument.
   * @returns Description.
   */
  async postComment(issueNumber: number, body: string): Promise<void> {
    await this.api(`/issues/${issueNumber}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  // ─── Review Operations ──────────────────────────────────

  /**
   * Create a check run for a commit. GitLab has no Checks-API equivalent, so
   * this is a no-op used to satisfy the shared PlatformAdapter interface.
   * @param _name - Check run name (unused).
   * @param _headSha - Commit SHA (unused).
   * @param _conclusion - Check run conclusion (unused).
   * @param _output - Optional output (unused).
   * @param _output.title - Output title (unused).
   * @param _output.summary - Output summary (unused).
   * @param _output.text - Optional output details (unused).
   * @returns Resolves to a sentinel id of 0.
   */
  async createCheckRun(
    _name: string,
    _headSha: string,
    _conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required',
    _output?: { title: string; summary: string; text?: string },
  ): Promise<{ id: number }> {
    return { id: 0 };
  }

  /**
   * Post review.
   * @param mrNumber
   * @param _commitSha
   * @param result
   * @param postInlineComments
   * @param suppressLowConfidence - suppressLowConfidence argument.
   * @returns Description.
   */
  async postReview(
    mrNumber: number,
    _commitSha: string,
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
      ? buildInlineComments(workingResult, await this.getDiffLines(mrNumber), suppressLowConfidence)
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

    // Post summary comment
    try {
      await this.api(`/merge_requests/${mrNumber}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
    } catch (err) {
      core.warning(`Failed to post review body comment: ${err}`);
      return { success: false, method: 'failed' };
    }

    if (inlineComments.length === 0) {
      return { success: true, method: 'body-only' };
    }

    // Fetch MR metadata once for diff_refs (avoid N+1)
    let baseSha = '';
    let headSha = '';
    try {
      const mrMeta = await this.api<{
        diff_refs?: { base_sha: string; head_sha: string; start_sha: string };
      }>(`/merge_requests/${mrNumber}`);
      if (mrMeta.diff_refs) {
        baseSha = mrMeta.diff_refs.base_sha;
        headSha = mrMeta.diff_refs.head_sha;
      }
    } catch (err) {
      core.warning(`Could not fetch MR metadata for SHA refs: ${err}`);
    }
    const startSha = baseSha || headSha;

    // Post inline comments as individual discussion threads
    for (const comment of inlineComments) {
      try {
        await this.api(`/merge_requests/${mrNumber}/discussions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: comment.body,
            position: {
              position_type: 'text',
              base_sha: baseSha || startSha,
              head_sha: headSha || startSha,
              start_sha: startSha,
              new_path: comment.path,
              new_line: comment.line,
              old_line: comment.side === 'LEFT' ? comment.line : undefined,
            },
          }),
        });
        commentIds.push({
          file: comment.path,
          line: comment.line,
          commentId: 0,
          side: comment.side,
        });
      } catch (err) {
        if (err instanceof Error && (err as Error & { status: number }).status === 422) {
          const fallbackBody = `**Inline comment (${comment.path}:${comment.line})**\n\n${comment.body}`;
          try {
            await this.api(`/merge_requests/${mrNumber}/notes`, {
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

    return { success: true, method: 'partial', commentIds };
  }

  /**
   * Post a single inline review comment immediately (streaming). GitLab
   * supports inline MR discussion notes; falls back to a plain note on failure.
   * @param mrNumber - Merge request number.
   * @param _commitSha - Head commit SHA.
   * @param comment - Inline comment payload.
   * @param comment.path - File path the comment anchors to.
   * @param comment.line - Diff line the comment anchors to.
   * @param comment.body - Comment body text.
   * @param comment.side - Diff side ('LEFT' or 'RIGHT').
   * @returns The created comment id, or null when the post fails.
   */
  async postInlineComment(
    mrNumber: number,
    _commitSha: string,
    comment: { path: string; line: number; body: string; side?: 'LEFT' | 'RIGHT' },
  ): Promise<{ commentId: number; nodeId?: string } | null> {
    try {
      const created = await this.api<{ id: number }>(`/merge_requests/${mrNumber}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: `**${comment.path}:${comment.line}** — ${comment.body}`,
          position: {
            position_type: 'text',
            new_path: comment.path,
            new_line: comment.line,
          },
        }),
      });
      return { commentId: created.id };
    } catch (err) {
      core.warning(
        `Streaming GitLab inline comment for ${comment.path}:${comment.line} failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * Post or update a streaming progress summary comment on a merge request.
   * @param mrNumber - Merge request number.
   * @param batchIndex - 1-based index of the batch that just completed.
   * @param totalBatches - Total number of batches.
   * @param findingCount - Number of findings posted so far.
   * @param lastFile - Optional last file reviewed.
   * @returns A promise that resolves once the progress comment is posted/updated.
   */
  async postStreamingProgress(
    mrNumber: number,
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
    await this.postOrUpdateComment(mrNumber, '<!-- review-stream-progress -->', body);
  }

  // ─── Comment Operations ─────────────────────────────────

  /**
   * Post or update comment.
   * @param issueNumber
   * @param marker
   * @param body - body argument.
   * @returns Description.
   */
  async postOrUpdateComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }> {
    // Single-flight per (apiUrl, repo, issue, marker): the read-then-write below
    // is not atomic under concurrent webhook events; share one in-flight upsert
    // so duplicate marker comments are never created. The key includes apiUrl
    // and repo so two different providers/repositories with the same issue
    // number + marker never share (and suppress) an upsert.
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
        `/issues/${issueNumber}/notes`,
        { perPage: 100, maxPages: 10, throwOnError: true },
      );

      const existing = allComments.find((c) => c.body?.startsWith(marker));

      if (existing) {
        await this.api(`/issues/${issueNumber}/notes/${existing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: markedBody }),
        });
        return { action: 'updated' as const, commentId: existing.id };
      }

      const created = await this.api<{ id: number }>(`/issues/${issueNumber}/notes`, {
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
   * Create comment.
   * @param issueNumber
   * @param body - body argument.
   * @returns Description.
   */
  async createComment(issueNumber: number, body: string): Promise<{ id: number }> {
    const created = await this.api<{ id: number }>(`/issues/${issueNumber}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return { id: created.id };
  }

  /**
   * Reply to review comment.
   * @param mrNumber
   * @param commentId
   * @param body - body argument.
   * @returns Description.
   */
  async replyToReviewComment(
    mrNumber: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number }> {
    const discussion = await this.api<{ discussion_id?: string }>(
      `/merge_requests/${mrNumber}/notes/${commentId}`,
    );
    const discussionId = discussion?.discussion_id || String(commentId);
    const result = await this.api<{ id: number }>(
      `/merge_requests/${mrNumber}/discussions/${discussionId}/notes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    return { id: result.id };
  }

  /**
   * Get review comment.
   * @param mrNumber
   * @param commentId - commentId argument.
   * @param signal - Optional AbortSignal to cancel the request.
   * @returns Description.
   */
  async getReviewComment(
    mrNumber: number,
    commentId: number,
    signal?: AbortSignal,
  ): Promise<ReviewCommentDetail> {
    return this.api<ReviewCommentDetail>(
      `/merge_requests/${mrNumber}/notes/${commentId}`,
      {},
      undefined,
      signal,
    );
  }

  /**
   * Get a single issue comment by ID.
   * @param issueNumber - Issue/PR number the comment belongs to.
   * @param commentId - Note ID.
   * @param signal - Optional AbortSignal to cancel the request.
   * @returns The raw issue comment (GitLab notes use author.username).
   */
  async getIssueComment(
    issueNumber: number,
    commentId: number,
    signal?: AbortSignal,
  ): Promise<{ id: number; body: string; user?: { login?: string } }> {
    const note = await this.api<{ id: number; body: string; author?: { username?: string } }>(
      `/issues/${issueNumber}/notes/${commentId}`,
      {},
      undefined,
      signal,
    );
    return { id: note.id, body: note.body, user: { login: note.author?.username } };
  }

  /**
   * Get review comment thread.
   * @param _commentId - _commentId argument.
   * @param _prNumber - Optional PR number (unused, thread reconstruction unsupported).
   * @param _signal - Optional AbortSignal (unused).
   * @returns Description.
   */
  async getReviewCommentThread(
    _commentId: number,
    _prNumber?: number,
    _signal?: AbortSignal,
  ): Promise<ReviewCommentThread> {
    core.warning('getReviewCommentThread not supported via GitLab REST API');
    return {
      comments: [],
      rootComment: { id: 0, author: '', body: '', isBot: false },
      filePath: '',
    };
  }

  /**
   * Create issue.
   * @param title
   * @param body
   * @param labels - labels argument.
   * @returns Description.
   */
  async createIssue(
    title: string,
    body: string,
    labels: string[],
  ): Promise<{ number: number; url: string } | null> {
    try {
      const result = await this.api<{ iid: number; web_url: string }>('/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: body, labels }),
      });
      return { number: result.iid, url: result.web_url };
    } catch (err) {
      core.warning(`Failed to create issue: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Create PR.
   * @param title
   * @param body
   * @param head
   * @param base - base argument.
   * @returns Description.
   */
  async createPR(
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<{ number: number; url: string } | null> {
    try {
      const result = await this.api<{ iid: number; web_url: string }>('/merge_requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: body,
          source_branch: head,
          target_branch: base,
        }),
      });
      return { number: result.iid, url: result.web_url };
    } catch (err) {
      core.warning(
        `Failed to create MR "${title}" (${head} → ${base}): ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  // ─── Label Operations ───────────────────────────────────

  /**
   * Add labels.
   * @param issueNumber
   * @param labels - labels argument.
   * @returns Description.
   */
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const existing = await this.api<{ labels: string[] }>(`/issues/${issueNumber}`);
    const merged = [...new Set([...(existing.labels || []), ...labels])];
    await this.api(`/issues/${issueNumber}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: merged.join(',') }),
    });
  }

  /**
   * Remove label.
   * @param issueNumber
   * @param label - label argument.
   * @returns Description.
   */
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      const current = await this.api<{ labels: string[] }>(`/issues/${issueNumber}`);
      const updated = (current.labels || []).filter((l: string) => l !== label);
      await this.api(`/issues/${issueNumber}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: updated.join(',') }),
      });
    } catch (err) {
      const status = err instanceof Error ? (err as Error & { status: number }).status : undefined;
      if (status === 404) return;
      core.warning(
        `Failed to remove label "${label}" on #${issueNumber}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Set labels.
   * @param issueNumber
   * @param add
   * @param remove - remove argument.
   * @returns Description.
   */
  async setLabels(issueNumber: number, add: string[], remove: string[]): Promise<void> {
    const current = await this.api<{ labels: string[] }>(`/issues/${issueNumber}`);
    const currentLabels = current.labels || [];
    const newLabels = [...currentLabels.filter((l: string) => !remove.includes(l)), ...add];
    await this.api(`/issues/${issueNumber}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: newLabels.join(',') }),
    });
  }

  /**
   * Ensure labels exist.
   * @param labels - labels argument.
   * @returns Description.
   */
  async ensureLabels(labels: string[]): Promise<void> {
    for (const label of labels) {
      try {
        await this.api('/labels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: label, color: `#${getLabelColor(label)}`, description: '' }),
        });
      } catch (err) {
        core.debug(
          `Label creation for "${label}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ─── Context ────────────────────────────────────────────

  /**
   * Gather context.
   * @param options
   * @param options.issueNumber
   * @param options.prNumber - options.prNumber argument.
   * @returns Description.
   */
  async gatherContext(options: {
    issueNumber?: number;
    prNumber?: number;
  }): Promise<string> {
    const parts: string[] = [];

    let allNotes: Array<Record<string, unknown>> = [];
    if (options.prNumber) {
      allNotes = await this.paginate<Record<string, unknown>>(
        `/merge_requests/${options.prNumber}/notes`,
      );
    }

    const [issue, mr] = await Promise.all([
      options.issueNumber ? this.getIssue(options.issueNumber) : Promise.resolve(undefined),
      options.prNumber ? this.getMR(options.prNumber) : Promise.resolve(undefined),
    ]);

    const reviewComments = allNotes as Array<{
      author: { username: string };
      body: string;
      created_at: string;
    }>;
    const reviews = allNotes as Array<{
      author: { username: string };
      state: string;
      body: string;
    }>;

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
          parts.push(`**@${c.author}** (${c.createdAt}):`);
          parts.push(c.body);
          parts.push('');
        }
      }
    }

    if (mr) {
      parts.push(`## MR #${mr.number}`);
      parts.push('');
      parts.push(`**Title:** ${mr.title}`);
      parts.push(`**Author:** ${mr.author}`);
      parts.push('');
      parts.push('### MR Description');
      parts.push('');
      parts.push(mr.body || 'No description.');
      parts.push('');

      if (reviewComments.length > 0) {
        parts.push('### Inline Review Comments');
        parts.push('');
        for (const rc of reviewComments) {
          parts.push(`**@${rc.author?.username || 'unknown'}** —`);
          parts.push(rc.body || '');
          parts.push('');
        }
      }

      const substantialReviews = reviews.filter((r) => r.body && r.body.trim().length > 0);
      if (substantialReviews.length > 0) {
        parts.push('### Reviews');
        parts.push('');
        for (const r of substantialReviews) {
          parts.push(`**@${r.author?.username || 'unknown'}** (${r.state}):`);
          parts.push(r.body || '');
          parts.push('');
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * Close opencode PRs.
   * @param since - since argument.
   * @returns Description.
   */
  async closeOpenCodePRs(since?: string): Promise<void> {
    /** MR summary type. */
    type MRSummary = { iid: number; source_branch: string; created_at: string };
    const mrs = await this.paginate<MRSummary>('/merge_requests?state=opened', { perPage: 100 });
    const opencodeMRs = mrs.filter(
      (mr) => mr.source_branch?.startsWith('opencode/') && (!since || mr.created_at >= since),
    );
    for (const mr of opencodeMRs) {
      try {
        await this.api(`/merge_requests/${mr.iid}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state_event: 'close' }),
        });
        core.info(`Closed auto-created MR #${mr.iid} (${mr.source_branch})`);
      } catch (err) {
        core.warning(
          `Could not close MR #${mr.iid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Merge MR.
   * @param mrNumber - mrNumber argument.
   * @returns Description.
   */
  async mergeMR(mrNumber: number): Promise<boolean> {
    try {
      await this.api(`/merge_requests/${mrNumber}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Enable auto-merge.
   * @param mrNumber - mrNumber argument.
   * @returns Description.
   */
  async enableAutoMerge(mrNumber: number): Promise<boolean> {
    try {
      await this.api(`/merge_requests/${mrNumber}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merge_when_pipeline_succeeds: true }),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close issue.
   * @param issueNumber
   * @param comment - comment argument.
   * @returns Description.
   */
  async closeIssue(issueNumber: number, comment?: string): Promise<void> {
    try {
      await this.api(`/issues/${issueNumber}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state_event: 'close' }),
      });
    } catch (err) {
      core.warning(
        `Failed to close issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (comment) {
      try {
        await this.api(`/issues/${issueNumber}/notes`, {
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

  // ─── Review Threads ─────────────────────────────────────

  /**
   * Get review threads.
   * @param _mrNumber - _mrNumber argument.
   * @returns Description.
   */
  async getReviewThreads(_mrNumber: number): Promise<ReviewThreadInfo[]> {
    core.warning('getReviewThreads not fully supported via GitLab REST API');
    return [];
  }

  /**
   * Resolve review thread.
   * @param _threadId - _threadId argument.
   * @returns Description.
   */
  async resolveReviewThread(_threadId: string): Promise<void> {
    core.warning('resolveReviewThread not supported for GitLab');
  }

  /**
   * Minimize review comment.
   * @param _commentId
   * @param _classifier - _classifier argument.
   * @returns Description.
   */
  async minimizeReviewComment(
    _commentId: string,
    _classifier: 'SPAM' | 'ABUSE' | 'OFF_TOPIC' | 'OUTDATED' | 'RESOLVED' | 'DUPLICATE',
  ): Promise<void> {
    core.warning('minimizeReviewComment not supported for GitLab');
  }

  /**
   * Get bot review threads.
   * @param _mrNumber - _mrNumber argument.
   * @returns Description.
   */
  async getBotReviewThreads(_mrNumber: number): Promise<ReviewThreadInfo[]> {
    return [];
  }

  /**
   * Get open human threads.
   * @param _mrNumber - _mrNumber argument.
   * @returns Description.
   */
  async getOpenHumanThreads(_mrNumber: number): Promise<string> {
    return '';
  }

  /**
   * Update MR.
   * @param mrNumber
   * @param updates
   * @param updates.title
   * @param updates.body - updates.body argument.
   * @returns Description.
   */
  async updateMR(mrNumber: number, updates: { title?: string; body?: string }): Promise<void> {
    const body: Record<string, string> = {};
    if (updates.title) body.title = updates.title;
    if (updates.body) body.description = updates.body;
    await this.api(`/merge_requests/${mrNumber}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Get current user.
   * @returns Current user login.
   */
  async getCurrentUser(): Promise<string> {
    if (this.currentUserLogin) return this.currentUserLogin;
    if (process.env.GITLAB_USER_LOGIN) {
      this.currentUserLogin = process.env.GITLAB_USER_LOGIN;
      return this.currentUserLogin;
    }

    try {
      const user = (await this.api<{ username: string }>('/user', {}, 'json')) as {
        username: string;
      };
      this.currentUserLogin = user.username;
      return user.username;
    } catch {
      this.currentUserLogin = 'opencode-reviewer[bot]';
      return this.currentUserLogin;
    }
  }
}
