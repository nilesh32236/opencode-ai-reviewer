import type {
  ChangedFile,
  IssueComment,
  IssueContext,
  PRContext,
  ReviewResult,
} from '../types/index.js';

/** Result of posting a review. */
export interface ReviewPostResult {
  success: boolean;
  method: 'full' | 'partial' | 'body-only' | 'failed';
  reviewId?: number;
  commentIds?: Array<{
    file: string;
    line: number;
    commentId: number;
    nodeId?: string;
    side?: string;
  }>;
}

/** Information about a review thread. */
export interface ReviewThreadInfo {
  threadId: string;
  isResolved: boolean;
  firstComment: {
    commentId: string;
    databaseId: number;
    body: string;
    filePath: string;
    lineNumber: number | null;
    author: string;
    createdAt: string;
  };
}

/** Details of a review comment. */
export interface ReviewCommentDetail {
  id: number;
  body: string;
  user: { login: string; type: string };
  path?: string;
  line?: number;
  in_reply_to_id?: number;
  pull_request_review_id?: number;
}

/** A thread of review comments. */
export interface ReviewCommentThread {
  comments: Array<{
    id: number;
    author: string;
    body: string;
    isBot: boolean;
  }>;
  rootComment: { id: number; author: string; body: string; isBot: boolean };
  filePath: string;
  lineNumber?: number;
}

/** Platform-agnostic adapter interface for interacting with Git hosting services. */
export interface PlatformAdapter {
  /**
   * Get merge request / pull request details.
   * @param number - Merge request number.
   * @returns Promise resolving to PR context.
   */
  getMR(number: number): Promise<PRContext>;
  /**
   * Check if a given number refers to a merge request (not an issue).
   * @param number - Issue/PR number.
   * @returns Promise resolving to true if the number refers to a merge request.
   */
  isMR(number: number): Promise<boolean>;
  /**
   * Get the default branch name of the repository.
   * @returns Promise resolving to the default branch name.
   */
  getDefaultBranch(): Promise<string>;
  /**
   * Get issue details.
   * @param number - Issue number.
   * @returns Promise resolving to issue context.
   */
  getIssue(number: number): Promise<IssueContext>;
  /**
   * Get all comments on an issue.
   * @param number - Issue number.
   * @param options - Optional pagination options.
   * @param options.throwOnError - When true, rethrow a pagination error instead of
   * silently returning partial comments (default: false).
   * @returns Promise resolving to array of issue comments.
   */
  getIssueComments(
    number: number,
    options?: { throwOnError?: boolean },
  ): Promise<IssueComment[]>;
  /**
   * Get the set of changed line identifiers for a merge request.
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to set of changed line identifiers.
   */
  getDiffLines(mrNumber: number): Promise<Set<string>>;
  /**
   * Get the diff between two SHAs.
   * @param fromSha - Starting SHA.
   * @param toSha - Ending SHA.
   * @returns Promise resolving to diff string.
   */
  getDiffSince(fromSha: string, toSha: string): Promise<string>;
  /**
   * List review comments on a merge request.
   * @param mrNumber - Merge request number.
   * @param options - Optional pagination options.
   * @param options.perPage - Items per page.
   * @param options.maxPages - Maximum pages to fetch.
   * @param options.direction - Sort direction.
   * @returns Promise resolving to array of review comments.
   */
  listReviewComments(
    mrNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
  ): Promise<Array<Record<string, unknown>>>;
  /**
   * Create a reply to an existing review comment.
   * @param mrNumber - Merge request number.
   * @param commentId - Comment ID to reply to.
   * @param body - Reply body text.
   * @returns Promise resolving when reply is posted.
   */
  createReviewCommentReply(mrNumber: number, commentId: number, body: string): Promise<void>;
  /**
   * List comments on an issue.
   * @param issueNumber - Issue number.
   * @param options - Optional pagination options.
   * @param options.perPage - Items per page.
   * @param options.maxPages - Maximum pages to fetch.
   * @param options.direction - Sort direction.
   * @returns Promise resolving to array of comments.
   */
  listComments(
    issueNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
  ): Promise<Array<Record<string, unknown>>>;
  /**
   * Post a comment on an issue.
   * @param issueNumber - Issue number.
   * @param body - Comment body text.
   * @returns Promise resolving when comment is posted.
   */
  postComment(issueNumber: number, body: string): Promise<void>;
  /**
   * Post a review on a merge request.
   * @param mrNumber - Merge request number.
   * @param commitSha - Commit SHA to review.
   * @param result - Review result data.
   * @param postInlineComments - Whether to post inline comments.
   * @param suppressLowConfidence - Whether to suppress low confidence comments.
   * @returns Promise resolving to review post result.
   */
  postReview(
    mrNumber: number,
    commitSha: string,
    result: ReviewResult,
    postInlineComments?: boolean,
    suppressLowConfidence?: boolean,
  ): Promise<ReviewPostResult>;
  /**
   * Post or update a marker-based comment.
   * @param issueNumber - Issue number.
   * @param marker - Marker string to identify the comment.
   * @param body - Comment body text.
   * @returns Promise resolving to action and comment ID.
   */
  postOrUpdateComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }>;
  /**
   * Create a new comment on an issue.
   * @param issueNumber - Issue number.
   * @param body - Comment body text.
   * @returns Promise resolving to created comment ID.
   */
  createComment(issueNumber: number, body: string): Promise<{ id: number }>;
  /**
   * Reply to an existing review comment.
   * @param mrNumber - Merge request number.
   * @param commentId - Comment ID to reply to.
   * @param body - Reply body text.
   * @returns Promise resolving to created reply comment ID.
   */
  replyToReviewComment(mrNumber: number, commentId: number, body: string): Promise<{ id: number }>;
  /**
   * Get a single review comment by ID.
   * @param mrNumber - Merge request number.
   * @param commentId - Comment ID.
   * @returns Promise resolving to review comment detail.
   */
  getReviewComment(mrNumber: number, commentId: number): Promise<ReviewCommentDetail>;
  /**
   * Get the thread containing a review comment.
   * @param commentId - Comment ID.
   * @param prNumber - Optional PR number, used to reconstruct the thread from the
   * paginated comment list in a single pass (avoids N+1 API calls).
   * @returns Promise resolving to review comment thread.
   */
  getReviewCommentThread(commentId: number, prNumber?: number): Promise<ReviewCommentThread>;
  /**
   * Create a new issue.
   * @param title - Issue title.
   * @param body - Issue body text.
   * @param labels - Labels to apply.
   * @returns Promise resolving to created issue details, or null on failure.
   */
  createIssue(
    title: string,
    body: string,
    labels: string[],
  ): Promise<{ number: number; url: string } | null>;
  /**
   * Create a new pull request.
   * @param title - Pull request title.
   * @param body - Pull request body text.
   * @param head - Head branch name.
   * @param base - Base branch name.
   * @returns Promise resolving to created PR details, or null on failure.
   */
  createPR(
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<{ number: number; url: string } | null>;
  /**
   * Add labels to an issue.
   * @param issueNumber - Issue number.
   * @param labels - Labels to add.
   * @returns Promise resolving when labels are added.
   */
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  /**
   * Remove a label from an issue.
   * @param issueNumber - Issue number.
   * @param label - Label to remove.
   * @returns Promise resolving when label is removed.
   */
  removeLabel(issueNumber: number, label: string): Promise<void>;
  /**
   * Replace labels on an issue (add some, remove others).
   * @param issueNumber - Issue number.
   * @param add - Labels to add.
   * @param remove - Labels to remove.
   * @returns Promise resolving when labels are set.
   */
  setLabels(issueNumber: number, add: string[], remove: string[]): Promise<void>;
  /**
   * Ensure the given labels exist in the repository.
   * @param labels - Labels to ensure exist.
   * @returns Promise resolving when labels are ensured.
   */
  ensureLabels(labels: string[]): Promise<void>;
  /**
   * Gather context markdown for an issue or merge request.
   * @param options - Options with optional issue or PR number.
   * @param options.issueNumber - Issue number for context.
   * @param options.prNumber - PR number for context.
   * @returns Promise resolving to context markdown string.
   */
  gatherContext(options: { issueNumber?: number; prNumber?: number }): Promise<string>;
  /**
   * Close existing opencode PRs older than the given date.
   * @param since - Optional date string to close PRs older than.
   * @returns Promise resolving when PRs are closed.
   */
  closeOpenCodePRs(since?: string): Promise<void>;
  /**
   * Merge a merge request.
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to true if merge was successful.
   */
  mergeMR(mrNumber: number): Promise<boolean>;
  /**
   * Enable auto-merge on a merge request.
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to true if auto-merge was enabled.
   */
  enableAutoMerge(mrNumber: number): Promise<boolean>;
  /**
   * Close an issue, optionally with a comment.
   * @param issueNumber - Issue number.
   * @param comment - Optional closing comment.
   * @returns Promise resolving when issue is closed.
   */
  closeIssue(issueNumber: number, comment?: string): Promise<void>;
  /**
   * Get all review threads for a merge request.
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to array of review threads.
   */
  getReviewThreads(mrNumber: number): Promise<ReviewThreadInfo[]>;
  /**
   * Resolve a review thread.
   * @param threadId - Thread ID to resolve.
   * @returns Promise resolving when thread is resolved.
   */
  resolveReviewThread(threadId: string): Promise<void>;
  /**
   * Minimize a review comment (mark as outdated/spam/etc.).
   * @param commentId - Comment ID to minimize.
   * @param classifier - Classification for the comment.
   * @returns Promise resolving when comment is minimized.
   */
  minimizeReviewComment(
    commentId: string,
    classifier: 'SPAM' | 'ABUSE' | 'OFF_TOPIC' | 'OUTDATED' | 'RESOLVED' | 'DUPLICATE',
  ): Promise<void>;
  /**
   * Get bot review threads for a merge request.
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to array of bot review threads.
   */
  getBotReviewThreads(mrNumber: number): Promise<ReviewThreadInfo[]>;
  /**
   * Get open human review threads as a markdown string.
   * @param mrNumber - Merge request number.
   * @returns Promise resolving to markdown string of open human threads.
   */
  getOpenHumanThreads(mrNumber: number): Promise<string>;
  /**
   * Update a merge request's title and/or body.
   * @param mrNumber - Merge request number.
   * @param updates - Object with optional title and/or body updates.
   * @param updates.title - New title.
   * @param updates.body - New body.
   * @returns Promise resolving when MR is updated.
   */
  updateMR(mrNumber: number, updates: { title?: string; body?: string }): Promise<void>;
  /**
   * Get the current authenticated user's login.
   * @returns Promise resolving to current user's login.
   */
  getCurrentUser(): Promise<string>;
  /**
   * Paginate through a REST API endpoint.
   * @param endpoint - REST API endpoint.
   * @param options - Optional pagination options.
   * @param options.perPage - Items per page.
   * @param options.maxPages - Maximum pages to fetch.
   * @param options.direction - Sort direction.
   * @param options.throwOnError - When true, rethrow a page-fetch error instead of
   * silently returning partial data (default: false).
   * @returns Promise resolving to array of paginated results.
   */
  paginate<T>(
    endpoint: string,
    options?: {
      perPage?: number;
      maxPages?: number;
      direction?: 'asc' | 'desc';
      throwOnError?: boolean;
    },
  ): Promise<T[]>;
}
