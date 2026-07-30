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
import { withRetry } from './retry.js';
import { buildReviewBody, getConfidenceBadge } from './review-body.js';

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
   * @param token - GitLab personal access token.
   * @param repo - Repository in 'owner/repo' format.
   * @param apiUrl - GitLab API base URL (defaults to https://gitlab.com/api/v4).
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
              throw err;
            }

            if (res.status === 204 || method === 'HEAD') return undefined as T;
            return responseType === 'text' ? (res.text() as T) : res.json();
          } finally {
            clearTimeout(timeout);
          }
        },
        {
          retryableStatuses: isIdempotent ? [429, 500, 502, 503, 504] : [429],
          retryUnknownStatus: isIdempotent,
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
   * Paginate through GitLab API endpoints, fetching all pages up to maxPages.
   * @param endpoint - API endpoint to paginate.
   * @param options - Optional pagination settings.
   * @param options.perPage - Items per page (default 100).
   * @param options.maxPages - Maximum pages to fetch (default 10).
   * @param options.direction - Sort direction for pagination.
   * @returns Array of paginated items from all pages.
   */
  async paginate<T>(
    endpoint: string,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
  ): Promise<T[]> {
    const perPage = options?.perPage ?? 100;
    const maxPages = options?.maxPages ?? 10;
    const allItems: T[] = [];
    let page = 1;

    while (page <= maxPages) {
      const separator = endpoint.includes('?') ? '&' : '?';
      const pagePath = `${endpoint}${separator}per_page=${perPage}&page=${page}`;
      try {
        const items = await this.api<T[]>(pagePath);
        allItems.push(...items);
        if (items.length < perPage) break;
      } catch (err) {
        core.warning(
          `Failed to fetch page ${page} for ${endpoint}: ${err instanceof Error ? err.message : err}`,
        );
        break;
      }
      page++;
    }

    return allItems;
  }

  // ─── MR Operations ──────────────────────────────────────

  /**
   * Fetch a merge request's metadata and changed files, extracting linked issue numbers from the description.
   * @param number - Merge request number.
   * @returns Promise resolving to PR context with details, changes, and linked issue info.
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
   * Check whether a given number refers to an existing merge request.
   * @param number - Merge request number.
   * @returns Promise resolving to true if the merge request exists.
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
   * Fetch an issue's details and its comments.
   * @param number - Issue number.
   * @returns Promise resolving to issue context with metadata and comments.
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
   * Fetch all comments for an issue.
   * @param number - Issue number.
   * @returns Promise resolving to array of issue comments.
   */
  async getIssueComments(number: number): Promise<IssueComment[]> {
    const comments = await this.paginate<{
      id: number;
      author: { username: string };
      created_at: string;
      body: string;
    }>(`/issues/${number}/notes`);

    return comments.map((c) => ({
      id: c.id,
      author: c.author.username,
      createdAt: c.created_at,
      body: c.body,
    }));
  }

  // ─── Diff Operations ────────────────────────────────────

  /**
   * Parse the merge request diff and return the set of changed line identifiers.
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to set of changed file:line identifiers.
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
   * Fetch the diff between two SHAs using the GitLab compare API.
   * @param fromSha - Starting SHA.
   * @param toSha - Ending SHA.
   * @returns Promise resolving to concatenated diff string.
   */
  async getDiffSince(fromSha: string, toSha: string): Promise<string> {
    try {
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
   * List all review comments on a merge request.
   * @param mrNumber - Merge request number.
   * @param options - Optional pagination settings.
   * @param options.perPage - Items per page.
   * @param options.maxPages - Maximum pages to fetch.
   * @param options.direction - Sort direction.
   * @returns Promise resolving to array of review comments.
   */
  async listReviewComments(
    mrNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
  ): Promise<Array<Record<string, unknown>>> {
    return this.paginate<Record<string, unknown>>(`/merge_requests/${mrNumber}/notes`, options);
  }

  /**
   * Create a reply to an existing review comment on a merge request.
   * @param mrNumber - Merge request number.
   * @param commentId - Comment ID to reply to.
   * @param body - Reply body text.
   * @returns Promise resolving when reply is posted.
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
   * List comments on an issue.
   * @param issueNumber - Issue number.
   * @param options - Optional pagination settings.
   * @param options.perPage - Items per page.
   * @param options.maxPages - Maximum pages to fetch.
   * @param options.direction - Sort direction.
   * @returns Promise resolving to array of comments.
   */
  async listComments(
    issueNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
  ): Promise<Array<Record<string, unknown>>> {
    return this.paginate<Record<string, unknown>>(`/issues/${issueNumber}/notes`, options);
  }

  /**
   * Post a new comment on an issue.
   * @param issueNumber - Issue number.
   * @param body - Comment body text.
   * @returns Promise resolving when comment is posted.
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
   * Post a full review on a merge request, including summary and inline comments.
   * @param mrNumber - Merge request number.
   * @param _commitSha - Commit SHA (unused for GitLab).
   * @param result - Review result data.
   * @param postInlineComments - Whether to post inline comments on the diff.
   * @param suppressLowConfidence - Whether to suppress low-confidence findings.
   * @returns Promise resolving to review post result with status and comment IDs.
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

  // ─── Comment Operations ─────────────────────────────────

  /**
   * Post a new comment or update an existing one identified by a marker prefix.
   * @param issueNumber - Issue number.
   * @param marker - Marker string to identify the comment.
   * @param body - Comment body text.
   * @returns Promise resolving to action taken and comment ID.
   */
  async postOrUpdateComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }> {
    try {
      const markedBody = `${marker}\n\n${body}`;

      const allComments = await this.paginate<{ id: number; body: string }>(
        `/issues/${issueNumber}/notes`,
        { perPage: 100, maxPages: 5 },
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
   * Create a new comment on an issue.
   * @param issueNumber - Issue number.
   * @param body - Comment body text.
   * @returns Promise resolving to created comment ID.
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
   * Reply to an existing review comment on a merge request.
   * @param mrNumber - Merge request number.
   * @param commentId - Comment ID to reply to.
   * @param body - Reply body text.
   * @returns Promise resolving to created reply comment ID.
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
   * Get a single review comment by ID.
   * @param mrNumber - Merge request number.
   * @param commentId - Comment ID.
   * @returns Promise resolving to review comment detail.
   */
  async getReviewComment(mrNumber: number, commentId: number): Promise<ReviewCommentDetail> {
    return this.api<ReviewCommentDetail>(`/merge_requests/${mrNumber}/notes/${commentId}`);
  }

  /**
   * Get the thread containing a review comment.
   * @param _commentId - Comment ID (unused, not supported via GitLab REST API).
   * @returns Promise resolving to an empty review comment thread.
   */
  async getReviewCommentThread(_commentId: number): Promise<ReviewCommentThread> {
    core.warning('getReviewCommentThread not supported via GitLab REST API');
    return {
      comments: [],
      rootComment: { id: 0, author: '', body: '', isBot: false },
      filePath: '',
    };
  }

  /**
   * Create a new issue in the repository.
   * @param title - Issue title.
   * @param body - Issue body text.
   * @param labels - Labels to apply.
   * @returns Promise resolving to created issue details, or null on failure.
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
   * Create a new merge request.
   * @param title - Merge request title.
   * @param body - Merge request description.
   * @param head - Source branch name.
   * @param base - Target branch name.
   * @returns Promise resolving to created MR details, or null on failure.
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
   * Add labels to an issue.
   * @param issueNumber - Issue number.
   * @param labels - Labels to add.
   * @returns Promise resolving when labels are added.
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
   * Remove a label from an issue.
   * @param issueNumber - Issue number.
   * @param label - Label to remove.
   * @returns Promise resolving when label is removed.
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
   * Replace labels on an issue (add some, remove others).
   * @param issueNumber - Issue number.
   * @param add - Labels to add.
   * @param remove - Labels to remove.
   * @returns Promise resolving when labels are set.
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
   * Ensure the given labels exist in the repository, creating them if needed.
   * @param labels - Labels to ensure exist.
   * @returns Promise resolving when labels are ensured.
   */
  async ensureLabels(labels: string[]): Promise<void> {
    for (const label of labels) {
      try {
        await this.api('/labels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: label, color: '#6699cc', description: '' }),
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
   * Gather markdown context for an issue or merge request, including comments and reviews.
   * @param options - Options with optional issue or PR number.
   * @param options.issueNumber - Issue number for context.
   * @param options.prNumber - PR number for context.
   * @returns Promise resolving to context markdown string.
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
   * Close existing opencode-created merge requests, optionally filtered by creation date.
   * @param since - Optional date string; only close MRs created on or after this date.
   * @returns Promise resolving when MRs are closed.
   */
  async closeOpenCodePRs(since?: string): Promise<void> {
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
   * Merge a merge request.
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to true if merge was successful.
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
   * Enable auto-merge on a merge request (merge when pipeline succeeds).
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to true if auto-merge was enabled.
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
   * Close an issue, optionally posting a closing comment.
   * @param issueNumber - Issue number.
   * @param comment - Optional closing comment.
   * @returns Promise resolving when issue is closed.
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
   * Get all review threads for a merge request.
   * @param _mrNumber - Merge request number (unused, limited GitLab REST API support).
   * @returns Promise resolving to array of review threads.
   */
  async getReviewThreads(_mrNumber: number): Promise<ReviewThreadInfo[]> {
    core.warning('getReviewThreads not fully supported via GitLab REST API');
    return [];
  }

  /**
   * Resolve a review thread.
   * @param _threadId - Thread ID to resolve (unused, not supported for GitLab).
   * @returns Promise resolving when thread is resolved.
   */
  async resolveReviewThread(_threadId: string): Promise<void> {
    core.warning('resolveReviewThread not supported for GitLab');
  }

  /**
   * Minimize a review comment (mark as outdated/spam/etc.).
   * @param _commentId - Comment ID to minimize (unused, not supported for GitLab).
   * @param _classifier - Classification for the comment (unused, not supported for GitLab).
   * @returns Promise resolving when comment is minimized.
   */
  async minimizeReviewComment(
    _commentId: string,
    _classifier: 'SPAM' | 'ABUSE' | 'OFF_TOPIC' | 'OUTDATED' | 'RESOLVED' | 'DUPLICATE',
  ): Promise<void> {
    core.warning('minimizeReviewComment not supported for GitLab');
  }

  /**
   * Get bot review threads for a merge request.
   * @param _mrNumber - Merge request number (unused, not fully supported for GitLab).
   * @returns Promise resolving to array of bot review threads.
   */
  async getBotReviewThreads(_mrNumber: number): Promise<ReviewThreadInfo[]> {
    return [];
  }

  /**
   * Get open human review threads as a markdown string.
   * @param _mrNumber - Merge request number (unused, not fully supported for GitLab).
   * @returns Promise resolving to empty string.
   */
  async getOpenHumanThreads(_mrNumber: number): Promise<string> {
    return '';
  }

  /**
   * Update a merge request's title and/or description.
   * @param mrNumber - Merge request number.
   * @param updates - Object with optional title and/or body updates.
   * @param updates.title - New title.
   * @param updates.body - New body.
   * @returns Promise resolving when MR is updated.
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
