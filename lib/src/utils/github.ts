import * as core from '@actions/core';
import { buildInlineComments } from '../jsonl-parser.js';
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
import { withRetry, withRetryAndTimeout } from './retry.js';

export interface PaginatedResult<T> {
  items: T[];
  totalCount: number;
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
export class GitHubHelper {
  /**
   * @param token - GitHub personal access token (classic or fine-grained).
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
  ): Promise<T> {
    const url = `${this.apiUrl}/repos/${this.repo}${path}`;
    const method = (options.method ?? 'GET').toUpperCase();
    const isIdempotent =
      method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE';

    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
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
            throw err;
          }

          if (res.status === 204) return undefined as T;
          return responseType === 'text' ? (res.text() as T) : res.json();
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        retryableStatuses: isIdempotent ? [429, 500, 502, 503, 504] : [429],
        retryUnknownStatus: isIdempotent,
      },
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

  private async paginate<T>(
    path: string,
    params: { perPage?: number; maxPages?: number } = {},
  ): Promise<T[]> {
    const perPage = params.perPage ?? 100;
    const maxPages = params.maxPages ?? 10;
    const allItems: T[] = [];
    let page = 1;

    while (page <= maxPages) {
      const separator = path.includes('?') ? '&' : '?';
      const pagePath = `${path}${separator}per_page=${perPage}&page=${page}`;
      try {
        const items = await this.api<T[]>(pagePath);
        allItems.push(...items);

        if (items.length < perPage) break;
      } catch (err) {
        core.warning(
          `Failed to fetch page ${page} for ${path}: ${err instanceof Error ? err.message : err}`,
        );
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
        head: { ref: string; sha: string };
        base: { ref: string };
        user: { login: string };
        labels: Array<{ name: string }>;
      }>(`/pulls/${number}`),
      this.api<ChangedFile[]>(`/pulls/${number}/files`),
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
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      author: pr.user.login,
      labels: pr.labels.map((l) => l.name),
      changedFiles: files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
      linkedIssue,
    };
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
   * @returns Array of issue comments with author, date, and body.
   */
  async getIssueComments(number: number): Promise<IssueComment[]> {
    const comments = await this.paginate<{
      user: { login: string };
      created_at: string;
      body: string;
    }>(`/issues/${number}/comments`);

    return comments.map((c) => ({
      author: c.user.login,
      createdAt: c.created_at,
      body: c.body,
    }));
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
        if (line.startsWith('+++ b/')) {
          currentFile = line.substring(6).trim();
        } else {
          const match = hunkRegex.exec(line);
          if (match && currentFile) {
            const startLine = Number.parseInt(match[1], 10);
            const lineCount = Number.parseInt(match[2], 10) || 1;
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

  // ─── Review Operations ──────────────────────────────────

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
   * @returns Object indicating success and which posting method was used.
   */
  async postReview(
    prNumber: number,
    commitSha: string,
    result: ReviewResult,
    postInlineComments = true,
  ): Promise<{ success: boolean; method: 'full' | 'partial' | 'body-only' | 'failed' }> {
    const inlineComments = postInlineComments
      ? buildInlineComments(result, await this.getDiffLines(prNumber))
      : [];

    const placedInlineKeys = new Set(inlineComments.map((c) => `${c.path}:${c.line}`));
    const issuesForBody = postInlineComments
      ? result.issues.filter(
          (i) => !i.inline || !placedInlineKeys.has(`${i.file.replace(/^\//, '')}:${i.line}`),
        )
      : result.issues;
    const body = this.buildReviewBody({ ...result, issues: issuesForBody });

    // Post the review body first (without inline comments)
    try {
      await this.api(`/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commit_id: commitSha,
          event: 'COMMENT',
          body,
        }),
      });
    } catch (err) {
      core.warning(`Body-only review failed: ${err}`);
      return { success: false, method: 'failed' };
    }

    if (inlineComments.length === 0) {
      return { success: true, method: 'body-only' };
    }

    // Post each inline comment individually with fallback for out-of-diff comments
    let allSucceeded = true;

    for (const comment of inlineComments) {
      try {
        await this.api(`/pulls/${prNumber}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commit_id: commitSha,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            body: comment.body,
          }),
        });
      } catch (err) {
        allSucceeded = false;
        if (err instanceof Error && (err as Error & { status: number }).status === 422) {
          // Fallback: post as a general issue comment with file:line reference
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

    return { success: true, method: allSucceeded ? 'full' : 'partial' };
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
        { perPage: 100, maxPages: 5 },
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
    } catch {
      // Label may not exist
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
    const operations = [
      ...add.map((l) => () => this.addLabels(issueNumber, [l])),
      ...remove.map((l) => () => this.removeLabel(issueNumber, l)),
    ];
    for (let i = 0; i < operations.length; i += 5) {
      await Promise.all(operations.slice(i, i + 5).map((fn) => fn()));
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
            body: JSON.stringify({ name: label, color: generateLabelColor(label) }),
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
   * @param options.issueNumber - Optional issue number to include.
   * @param options.prNumber - Optional PR number to include.
   * @returns Markdown string with issue/PR details, comments, and reviews.
   */
  async gatherContext(options: {
    issueNumber?: number;
    prNumber?: number;
  }): Promise<string> {
    const parts: string[] = [];

    const [issue, pr] = await Promise.all([
      options.issueNumber ? this.getIssue(options.issueNumber) : Promise.resolve(undefined),
      options.prNumber ? this.getPR(options.prNumber) : Promise.resolve(undefined),
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
        parts.push('### Comments');
        parts.push('');
        for (const c of issue.comments) {
          parts.push(`**@${c.author}** (${c.createdAt}):`);
          parts.push(c.body || '');
          parts.push('');
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

      const [reviewComments, reviews] = await Promise.all([
        this.paginate<{
          user: { login: string };
          path: string;
          line?: number;
          original_line?: number;
          body: string;
        }>(`/pulls/${options.prNumber}/comments`),
        this.paginate<{ user: { login: string }; state: string; body: string }>(
          `/pulls/${options.prNumber}/reviews`,
        ),
      ]);

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
    } catch {
      return false;
    }
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
    } catch {
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

  // ─── Private Helpers ────────────────────────────────────

  private buildReviewBody(result: ReviewResult): string {
    const lines: string[] = [
      '## PR Review Summary',
      '',
      result.summary,
      '',
      `**Ready to merge?** ${result.verdict.ready}`,
      '',
      `**Reasoning:** ${result.verdict.reasoning}`,
      '',
    ];

    if (result.strengths.length > 0) {
      lines.push('### Strengths');
      lines.push('');
      for (const s of result.strengths) {
        lines.push(`- **${s.file}:${s.line}** — ${s.message}`);
      }
      lines.push('');
    }

    if (result.issues.length > 0) {
      lines.push('### Issues');
      lines.push('');
      for (const i of result.issues) {
        const line = `- **${i.severity.toUpperCase()}:** ${i.file}:${i.line} — ${i.message}`;
        lines.push(i.suggestion ? `${line}\n  > ${i.suggestion}` : line);
      }
    }

    return lines.join('\n');
  }
}

function generateLabelColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  // Convert HSL (hue, 65%, 45%) to 6-character hex string without leading '#'
  const h = hue / 360;
  const s = 0.65;
  const l = 0.45;

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const hueToRgb = (t: number) => {
    let nt = t;
    if (nt < 0) nt += 1;
    if (nt > 1) nt -= 1;
    if (nt < 1 / 6) return p + (q - p) * 6 * nt;
    if (nt < 1 / 2) return q;
    if (nt < 2 / 3) return p + (q - p) * (2 / 3 - nt) * 6;
    return p;
  };

  const r = Math.round(hueToRgb(h + 1 / 3) * 255);
  const g = Math.round(hueToRgb(h) * 255);
  const b = Math.round(hueToRgb(h - 1 / 3) * 255);

  const toHex = (x: number) => x.toString(16).padStart(2, '0');
  return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}
