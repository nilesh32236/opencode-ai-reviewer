import * as core from '@actions/core';
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
import { withRetry } from './retry.js';

export class GitHubHelper {
  constructor(
    private token: string,
    private repo: string,
    private apiUrl = 'https://api.github.com',
  ) {}

  private async api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.apiUrl}/repos/${this.repo}${path}`;

    return withRetry(async () => {
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...options.headers,
        },
      });

      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`GitHub API ${res.status} on ${path}: ${body}`);
        (err as Error & { status: number }).status = res.status;
        throw err;
      }

      if (res.status === 204) return undefined as T;
      return res.json();
    }, {
      retryableStatuses: [429, 500, 502, 503, 504],
    });
  }

  // ─── PR Operations ──────────────────────────────────────

  async getPR(number: number): Promise<PRContext> {
    const pr = await this.api<{
      number: number;
      title: string;
      body: string | null;
      head: { ref: string; sha: string };
      base: { ref: string };
      user: { login: string };
      labels: Array<{ name: string }>;
    }>(`/pulls/${number}`);

    const files = await this.api<ChangedFile[]>(`/pulls/${number}/files`);

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

  async isPR(number: number): Promise<boolean> {
    try {
      await this.api(`/pulls/${number}`, { method: 'HEAD' });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Issue Operations ───────────────────────────────────

  async getIssue(number: number): Promise<IssueContext> {
    const issue = await this.api<{
      number: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string }>;
    }>(`/issues/${number}`);

    const comments = await this.api<
      Array<{
        user: { login: string };
        created_at: string;
        body: string;
      }>
    >(`/issues/${number}/comments`);

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

  async getPRComments(number: number): Promise<ReviewComment[]> {
    const comments = await this.api<
      Array<{
        user: { login: string };
        path: string;
        line?: number;
        body: string;
      }>
    >(`/pulls/${number}/comments`);

    return comments.map((c) => ({
      author: c.user.login,
      path: c.path,
      line: c.line,
      body: c.body,
    }));
  }

  async getIssueComments(number: number): Promise<IssueComment[]> {
    const comments = await this.api<
      Array<{
        user: { login: string };
        created_at: string;
        body: string;
      }>
    >(`/issues/${number}/comments`);

    return comments.map((c) => ({
      author: c.user.login,
      createdAt: c.created_at,
      body: c.body,
    }));
  }

  // ─── Diff Operations ────────────────────────────────────

  async getDiffLines(prNumber: number): Promise<Set<string>> {
    try {
      const url = `${this.apiUrl}/repos/${this.repo}/pulls/${prNumber}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.v3.diff',
        },
      });
      if (!res.ok) {
        core.warning(`Diff fetch returned ${res.status}`);
        return new Set();
      }
      const diffText = await res.text();
      const lines = new Set<string>();
      const hunkRegex = /^@@\s+-[0-9,]+\s+\+([0-9]+),([0-9]+)\s+@@/gm;
      let match: RegExpExecArray | null;
      while ((match = hunkRegex.exec(diffText)) !== null) {
        const startLine = Number.parseInt(match[1], 10);
        const lineCount = Number.parseInt(match[2], 10);
        for (let i = 0; i < lineCount; i++) {
          lines.add(`${startLine + i}`);
        }
      }
      return lines;
    } catch (err) {
      core.warning(`Could not fetch PR diff for line validation: ${String(err)}`);
      return new Set();
    }
  }

  // ─── Review Operations ──────────────────────────────────

  async postReview(
    prNumber: number,
    commitSha: string,
    result: ReviewResult,
  ): Promise<{ success: boolean; method: 'full' | 'body-only' | 'failed' }> {
    const inlineComments = result.issues
      .filter((i) => i.inline)
      .map((i) => ({
        path: i.file,
        line: i.line,
        side: 'RIGHT' as const,
        body: `**${i.severity.toUpperCase()}**: ${i.message}${i.suggestion ? `\n\n> ${i.suggestion}` : ''}`,
      }));

    const body = this.buildReviewBody(result);

    if (inlineComments.length > 0) {
      try {
        await this.api(`/pulls/${prNumber}/reviews`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commit_id: commitSha,
            event: 'COMMENT',
            body,
            comments: inlineComments,
          }),
        });
        return { success: true, method: 'full' };
      } catch (err) {
        if (err instanceof Error && err.message.includes('422')) {
          core.warning('Inline comments rejected (lines not in diff). Retrying body-only.');
        } else {
          core.warning(`Review API failed: ${err}`);
          return { success: false, method: 'failed' };
        }
      }
    }

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
      return { success: true, method: 'body-only' };
    } catch (err) {
      core.warning(`Body-only review failed: ${err}`);
      return { success: false, method: 'failed' };
    }
  }

  // ─── Comment Operations ─────────────────────────────────

  async postOrUpdateComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<{ action: 'created' | 'updated'; commentId: number }> {
    const markedBody = `${marker}\n\n${body}`;

    const allComments = await this.api<Array<{ id: number; body: string }>>(
      `/issues/${issueNumber}/comments`,
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
  }

  async createIssue(
    title: string,
    body: string,
    labels: string[],
  ): Promise<{ number: number; url: string }> {
    const result = await this.api<{ number: number; html_url: string }>('/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, labels }),
    });
    return { number: result.number, url: result.html_url };
  }

  // ─── Label Operations ───────────────────────────────────

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.api(`/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels }),
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.api(`/issues/${issueNumber}/labels/${label}`, { method: 'DELETE' });
    } catch {
      // Label may not exist
    }
  }

  async setLabels(issueNumber: number, add: string[], remove: string[]): Promise<void> {
    await Promise.all([
      ...add.map((l) => this.addLabels(issueNumber, [l])),
      ...remove.map((l) => this.removeLabel(issueNumber, l)),
    ]);
  }

  async ensureLabels(labels: string[]): Promise<void> {
    await Promise.all(
      labels.map((label) =>
        this.api('/labels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: label, color: generateLabelColor(label) }),
        }).catch(() => {
          // Label already exists
        }),
      ),
    );
  }

  // ─── Context ────────────────────────────────────────────

  async gatherContext(options: {
    issueNumber?: number;
    prNumber?: number;
  }): Promise<string> {
    const parts: string[] = [];

    if (options.issueNumber) {
      const issue = await this.getIssue(options.issueNumber);
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

      const comments = await this.api<
        Array<{ user: { login: string }; created_at: string; body: string }>
      >(`/issues/${options.issueNumber}/comments`);
      if (comments.length > 0) {
        parts.push('### Comments');
        parts.push('');
        for (const c of comments) {
          parts.push(`**@${c.user?.login}** (${c.created_at}):`);
          parts.push(c.body || '');
          parts.push('');
        }
      }
    }

    if (options.prNumber) {
      const pr = await this.getPR(options.prNumber);
      parts.push(`## PR #${pr.number}`);
      parts.push('');
      parts.push(`**Title:** ${pr.title}`);
      parts.push(`**Author:** ${pr.author}`);
      parts.push('');
      parts.push('### PR Description');
      parts.push('');
      parts.push(pr.body || 'No description.');
      parts.push('');

      const reviewComments = await this.api<
        Array<{
          user: { login: string };
          path: string;
          line?: number;
          original_line?: number;
          body: string;
        }>
      >(`/pulls/${options.prNumber}/comments`);
      if (reviewComments.length > 0) {
        parts.push('### Inline Review Comments');
        parts.push('');
        for (const rc of reviewComments) {
          parts.push(`**@${rc.user?.login}** on \`${rc.path}:${rc.line || rc.original_line}\`:`);
          parts.push(rc.body || '');
          parts.push('');
        }
      }

      type Review = { user: { login: string }; state: string; body: string };
      const reviews = await this.api<Review[]>(`/pulls/${options.prNumber}/reviews`);
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

  async closeOpenCodePRs(since?: string): Promise<void> {
    type PRSummary = { number: number; head: { ref: string }; created_at: string };
    const prs = await this.api<PRSummary[]>('/pulls?state=open&per_page=100');
    for (const pr of prs) {
      if (pr.head?.ref?.startsWith('opencode/')) {
        if (since && pr.created_at < since) continue;
        try {
          await this.api(`/pulls/${pr.number}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'closed' }),
          });
          core.info(`Closed auto-created PR #${pr.number} (${pr.head.ref})`);
        } catch {
          core.debug(`Could not close PR #${pr.number}`);
        }
      }
    }
  }

  // ─── PR Merge ───────────────────────────────────────────

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

  async closeIssue(issueNumber: number, comment?: string): Promise<void> {
    await this.api(`/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: 'closed',
        ...(comment ? { state_reason: 'completed' } : {}),
      }),
    });

    if (comment) {
      await this.api(`/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: comment }),
      });
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
  return `hsl(${hue}, 65%, 45%)`;
}
