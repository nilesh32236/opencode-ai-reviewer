import type {
  IssueComment,
  IssueContext,
  PRContext,
  PlatformAdapter,
  ReviewCommentDetail,
  ReviewCommentThread,
  ReviewPostResult,
  ReviewThreadInfo,
} from '@opencode-pr-agent/lib';

/**
 * Minimal {@link PlatformAdapter} for local CLI reviews.
 *
 * The review engine touches the platform adapter in only a handful of places
 * during `reviewPR` (all gracefully degraded inside try/catch), so a stub is
 * sufficient — no GitHub token, no network, no webhook server required.
 * Unused mutating/query methods throw so accidental use surfaces immediately.
 */
export class LocalAdapter implements PlatformAdapter {
  /**
   * Get merge request details.
   * @param _number - Merge request number.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async getMR(_number: number): Promise<PRContext> {
    throw new Error('getMR is not available in local CLI mode');
  }

  /**
   * Check if a number refers to a merge request.
   * @param _number - Issue/PR number.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async isMR(_number: number): Promise<boolean> {
    throw new Error('isMR is not available in local CLI mode');
  }

  /**
   * Get the default branch name.
   * @returns The literal branch name "HEAD".
   */
  async getDefaultBranch(): Promise<string> {
    return 'HEAD';
  }

  /**
   * Get issue details.
   * @param _number - Issue number.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async getIssue(_number: number): Promise<IssueContext> {
    throw new Error('getIssue is not available in local CLI mode');
  }

  /**
   * Get comments on an issue.
   * @param _number - Issue number.
   * @param _options - Optional pagination options.
   * @param _options.throwOnError - Whether to rethrow a pagination error.
   * @returns An empty comment list.
   */
  async getIssueComments(
    _number: number,
    _options?: { throwOnError?: boolean },
  ): Promise<IssueComment[]> {
    return [];
  }

  /**
   * Get a single issue comment.
   * @param _issueNumber - Issue number.
   * @param _commentId - Comment ID.
   * @param _signal - Optional AbortSignal.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async getIssueComment(
    _issueNumber: number,
    _commentId: number,
    _signal?: AbortSignal,
  ): Promise<{ id: number; body: string; user?: { login?: string } }> {
    throw new Error('getIssueComment is not available in local CLI mode');
  }

  /**
   * Get the changed line identifiers for a merge request.
   * @param _mrNumber - Merge request number.
   * @returns An empty set of line identifiers.
   */
  async getDiffLines(_mrNumber: number): Promise<Set<string>> {
    return new Set();
  }

  /**
   * Get the diff between two SHAs.
   * @param _fromSha - Starting SHA.
   * @param _toSha - Ending SHA.
   * @returns An empty diff string.
   */
  async getDiffSince(_fromSha: string, _toSha: string): Promise<string> {
    return '';
  }

  /**
   * List review comments on a merge request.
   * @param _mrNumber - Merge request number.
   * @param _options - Optional pagination options.
   * @param _options.perPage - Items per page.
   * @param _options.maxPages - Maximum pages to fetch.
   * @param _options.direction - Sort direction.
   * @param _signal - Optional AbortSignal.
   * @returns An empty comment list.
   */
  async listReviewComments(
    _mrNumber: number,
    _options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
    _signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  /**
   * Create a reply to a review comment.
   * @param _mrNumber - Merge request number.
   * @param _commentId - Comment ID to reply to.
   * @param _body - Reply body text.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async createReviewCommentReply(
    _mrNumber: number,
    _commentId: number,
    _body: string,
  ): Promise<void> {
    throw new Error('createReviewCommentReply is not available in local CLI mode');
  }

  /**
   * List comments on an issue.
   * @param _issueNumber - Issue number.
   * @param _options - Optional pagination options.
   * @param _options.perPage - Items per page.
   * @param _options.maxPages - Maximum pages to fetch.
   * @param _options.direction - Sort direction.
   * @param _signal - Optional AbortSignal.
   * @returns An empty comment list.
   */
  async listComments(
    _issueNumber: number,
    _options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
    _signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  /**
   * Post a comment on an issue.
   * @param _issueNumber - Issue number.
   * @param _body - Comment body text.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async postComment(_issueNumber: number, _body: string): Promise<void> {
    throw new Error('postComment is not available in local CLI mode');
  }

  /**
   * Post a review on a merge request.
   * @param _mrNumber - Merge request number.
   * @param _commitSha - Commit SHA to review.
   * @param _result - Review result data.
   * @param _postInlineComments - Whether to post inline comments.
   * @param _suppressLowConfidence - Whether to suppress low-confidence comments.
   * @returns A successful no-op post result.
   */
  async postReview(
    _mrNumber: number,
    _commitSha: string,
    _result: unknown,
    _postInlineComments?: boolean,
    _suppressLowConfidence?: boolean,
  ): Promise<ReviewPostResult> {
    return { success: true, method: 'body-only' };
  }

  /**
   * Create a check run for a commit. No-op in local CLI mode (no Checks API).
   * @param _name - Check run name.
   * @param _headSha - Commit SHA.
   * @param _conclusion - Check run conclusion.
   * @param _output - Optional output.
   * @param _output.title - Output title.
   * @param _output.summary - Output summary.
   * @param _output.text - Optional output details.
   * @returns A sentinel id of 0.
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
   * Post or update a marker-based comment.
   * @param _issueNumber - Issue number.
   * @param _marker - Marker string.
   * @param _body - Comment body.
   * @returns A no-op "created" action.
   */
  async postOrUpdateComment(
    _issueNumber: number,
    _marker: string,
    _body: string,
  ): Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }> {
    return { action: 'created', commentId: 0 };
  }

  /**
   * Create a comment on an issue.
   * @param _issueNumber - Issue number.
   * @param _body - Comment body.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async createComment(_issueNumber: number, _body: string): Promise<{ id: number }> {
    throw new Error('createComment is not available in local CLI mode');
  }

  /**
   * Reply to a review comment.
   * @param _mrNumber - Merge request number.
   * @param _commentId - Comment ID.
   * @param _body - Reply body.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async replyToReviewComment(
    _mrNumber: number,
    _commentId: number,
    _body: string,
  ): Promise<{ id: number }> {
    throw new Error('replyToReviewComment is not available in local CLI mode');
  }

  /**
   * Get a review comment by ID.
   * @param _mrNumber - Merge request number.
   * @param _commentId - Comment ID.
   * @param _signal - Optional AbortSignal.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async getReviewComment(
    _mrNumber: number,
    _commentId: number,
    _signal?: AbortSignal,
  ): Promise<ReviewCommentDetail> {
    throw new Error('getReviewComment is not available in local CLI mode');
  }

  /**
   * Get the thread containing a review comment.
   * @param _commentId - Comment ID.
   * @param _prNumber - Optional PR number.
   * @param _signal - Optional AbortSignal.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async getReviewCommentThread(
    _commentId: number,
    _prNumber?: number,
    _signal?: AbortSignal,
  ): Promise<ReviewCommentThread> {
    throw new Error('getReviewCommentThread is not available in local CLI mode');
  }

  /**
   * Create a new issue.
   * @param _title - Issue title.
   * @param _body - Issue body.
   * @param _labels - Labels to apply.
   * @returns Null (no issue created locally).
   */
  async createIssue(
    _title: string,
    _body: string,
    _labels: string[],
  ): Promise<{ number: number; url: string } | null> {
    return null;
  }

  /**
   * Create a new pull request.
   * @param _title - PR title.
   * @param _body - PR body.
   * @param _head - Head branch name.
   * @param _base - Base branch name.
   * @returns Null (no PR created locally).
   */
  async createPR(
    _title: string,
    _body: string,
    _head: string,
    _base: string,
  ): Promise<{ number: number; url: string } | null> {
    return null;
  }

  /**
   * Add labels to an issue.
   * @param _issueNumber - Issue number.
   * @param _labels - Labels to add.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async addLabels(_issueNumber: number, _labels: string[]): Promise<void> {
    throw new Error('addLabels is not available in local CLI mode');
  }

  /**
   * Remove a label from an issue.
   * @param _issueNumber - Issue number.
   * @param _label - Label to remove.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async removeLabel(_issueNumber: number, _label: string): Promise<void> {
    throw new Error('removeLabel is not available in local CLI mode');
  }

  /**
   * Replace labels on an issue.
   * @param _issueNumber - Issue number.
   * @param _add - Labels to add.
   * @param _remove - Labels to remove.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async setLabels(_issueNumber: number, _add: string[], _remove: string[]): Promise<void> {
    throw new Error('setLabels is not available in local CLI mode');
  }

  /**
   * Ensure labels exist in the repository.
   * @param _labels - Labels to ensure.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async ensureLabels(_labels: string[]): Promise<void> {
    throw new Error('ensureLabels is not available in local CLI mode');
  }

  /**
   * Gather context markdown for an issue or merge request.
   * @param _options - Options with optional issue or PR number.
   * @param _options.issueNumber - Issue number for context.
   * @param _options.prNumber - PR number for context.
   * @returns An empty context string.
   */
  async gatherContext(_options: { issueNumber?: number; prNumber?: number }): Promise<string> {
    return '';
  }

  /**
   * Close opencode PRs older than a date.
   * @param _since - Optional date string.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async closeOpenCodePRs(_since?: string): Promise<void> {
    throw new Error('closeOpenCodePRs is not available in local CLI mode');
  }

  /**
   * Merge a merge request.
   * @param _mrNumber - Merge request number.
   * @returns False (no merge performed locally).
   */
  async mergeMR(_mrNumber: number): Promise<boolean> {
    return false;
  }

  /**
   * Enable auto-merge on a merge request.
   * @param _mrNumber - Merge request number.
   * @returns False (no auto-merge enabled locally).
   */
  async enableAutoMerge(_mrNumber: number): Promise<boolean> {
    return false;
  }

  /**
   * Close an issue.
   * @param _issueNumber - Issue number.
   * @param _comment - Optional closing comment.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async closeIssue(_issueNumber: number, _comment?: string): Promise<void> {
    throw new Error('closeIssue is not available in local CLI mode');
  }

  /**
   * Get all review threads for a merge request.
   * @param _mrNumber - Merge request number.
   * @returns An empty thread list.
   */
  async getReviewThreads(_mrNumber: number): Promise<ReviewThreadInfo[]> {
    return [];
  }

  /**
   * Resolve a review thread.
   * @param _threadId - Thread ID to resolve.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async resolveReviewThread(_threadId: string): Promise<void> {
    throw new Error('resolveReviewThread is not available in local CLI mode');
  }

  /**
   * Minimize a review comment.
   * @param _commentId - Comment ID.
   * @param _classifier - Classification for the comment.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async minimizeReviewComment(
    _commentId: string,
    _classifier: 'SPAM' | 'ABUSE' | 'OFF_TOPIC' | 'OUTDATED' | 'RESOLVED' | 'DUPLICATE',
  ): Promise<void> {
    throw new Error('minimizeReviewComment is not available in local CLI mode');
  }

  /**
   * Get bot review threads for a merge request.
   * @param _mrNumber - Merge request number.
   * @returns An empty thread list.
   */
  async getBotReviewThreads(_mrNumber: number): Promise<ReviewThreadInfo[]> {
    return [];
  }

  /**
   * Get open human review threads as markdown.
   * @param _mrNumber - Merge request number.
   * @returns An empty markdown string (no threads locally).
   */
  async getOpenHumanThreads(_mrNumber: number): Promise<string> {
    return '';
  }

  /**
   * Update a merge request's title and/or body.
   * @param _mrNumber - Merge request number.
   * @param _updates - Title and/or body updates.
   * @param _updates.title - New title.
   * @param _updates.body - New body.
   * @throws Error Always, unsupported in local CLI mode.
   */
  async updateMR(_mrNumber: number, _updates: { title?: string; body?: string }): Promise<void> {
    throw new Error('updateMR is not available in local CLI mode');
  }

  /**
   * Get the current authenticated user's login.
   * @returns The literal login "local-user".
   */
  async getCurrentUser(): Promise<string> {
    return 'local-user';
  }

  /**
   * Paginate through a REST API endpoint.
   * @param _endpoint - REST API endpoint.
   * @param _options - Optional pagination options.
   * @param _options.perPage - Items per page.
   * @param _options.maxPages - Maximum pages to fetch.
   * @param _options.direction - Sort direction.
   * @param _options.throwOnError - Whether to rethrow a page-fetch error.
   * @param _signal - Optional AbortSignal.
   * @returns An empty result list.
   */
  async paginate<T>(
    _endpoint: string,
    _options?: {
      perPage?: number;
      maxPages?: number;
      direction?: 'asc' | 'desc';
      throwOnError?: boolean;
    },
    _signal?: AbortSignal,
  ): Promise<T[]> {
    return [];
  }
}
