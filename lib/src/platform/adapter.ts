import type {
  ChangedFile,
  IssueComment,
  IssueContext,
  PRContext,
  ReviewResult,
} from '../types/index.js';

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

export interface ReviewCommentDetail {
  id: number;
  body: string;
  user: { login: string; type: string };
  path?: string;
  line?: number;
  in_reply_to_id?: number;
  pull_request_review_id?: number;
}

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

export interface PlatformAdapter {
  getMR(number: number): Promise<PRContext>;
  isMR(number: number): Promise<boolean>;
  getDefaultBranch(): Promise<string>;
  getIssue(number: number): Promise<IssueContext>;
  getIssueComments(number: number): Promise<IssueComment[]>;
  getDiffLines(mrNumber: number): Promise<Set<string>>;
  getDiffSince(fromSha: string, toSha: string): Promise<string>;
  listReviewComments(
    mrNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
  ): Promise<Array<Record<string, unknown>>>;
  createReviewCommentReply(mrNumber: number, commentId: number, body: string): Promise<void>;
  listComments(
    issueNumber: number,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
  ): Promise<Array<Record<string, unknown>>>;
  postComment(issueNumber: number, body: string): Promise<void>;
  postReview(
    mrNumber: number,
    commitSha: string,
    result: ReviewResult,
    postInlineComments?: boolean,
    suppressLowConfidence?: boolean,
  ): Promise<ReviewPostResult>;
  postOrUpdateComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<{ action: 'created' | 'updated' | 'failed'; commentId: number }>;
  createComment(issueNumber: number, body: string): Promise<{ id: number }>;
  replyToReviewComment(mrNumber: number, commentId: number, body: string): Promise<{ id: number }>;
  getReviewComment(mrNumber: number, commentId: number): Promise<ReviewCommentDetail>;
  getReviewCommentThread(commentId: number): Promise<ReviewCommentThread>;
  createIssue(
    title: string,
    body: string,
    labels: string[],
  ): Promise<{ number: number; url: string } | null>;
  createPR(
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<{ number: number; url: string } | null>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  setLabels(issueNumber: number, add: string[], remove: string[]): Promise<void>;
  ensureLabels(labels: string[]): Promise<void>;
  gatherContext(options: { issueNumber?: number; prNumber?: number }): Promise<string>;
  closeOpenCodePRs(since?: string): Promise<void>;
  mergeMR(mrNumber: number): Promise<boolean>;
  enableAutoMerge(mrNumber: number): Promise<boolean>;
  closeIssue(issueNumber: number, comment?: string): Promise<void>;
  getReviewThreads(mrNumber: number): Promise<ReviewThreadInfo[]>;
  resolveReviewThread(threadId: string): Promise<void>;
  minimizeReviewComment(
    commentId: string,
    classifier: 'SPAM' | 'ABUSE' | 'OFF_TOPIC' | 'OUTDATED' | 'RESOLVED' | 'DUPLICATE',
  ): Promise<void>;
  getBotReviewThreads(mrNumber: number): Promise<ReviewThreadInfo[]>;
  getOpenHumanThreads(mrNumber: number): Promise<string>;
  updateMR(mrNumber: number, updates: { title?: string; body?: string }): Promise<void>;
  getCurrentUser(): Promise<string>;
  paginate<T>(
    endpoint: string,
    options?: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' },
  ): Promise<T[]>;
}
