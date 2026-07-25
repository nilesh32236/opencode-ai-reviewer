import type {
  AgentConfig,
  ConversationContext,
  ConversationMessage,
  LearningStore,
  PRContext,
} from '@opencode-pr-agent/lib';
import { GitHubHelper, Logger, ReviewEngine, detectIntent } from '@opencode-pr-agent/lib';

/**
 * Handle an interactive conversation triggered by an @mention in a PR comment.
 * Gathers the conversation thread context, detects intent, runs the conversation
 * through the review engine, and posts the response as a reply comment.
 *
 * @param commentId - ID of the comment that triggered the mention.
 * @param prNumber - PR number the comment belongs to.
 * @param repo - Repository in "owner/repo" format.
 * @param token - GitHub API token.
 * @param config - Agent configuration.
 * @param isReviewComment - Whether the comment is an inline review comment (vs. issue comment).
 * @param learningStore - Optional learning store for the engine.
 * @param signal - Optional abort signal for cancellation.
 * @param tempDir - Optional temporary working directory.
 */
export async function handleConversation(
  commentId: number,
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  isReviewComment: boolean,
  learningStore?: LearningStore,
  signal?: AbortSignal,
  tempDir?: string,
): Promise<void> {
  const logger = new Logger('Conversation', { prNumber, repo });
  logger.info(`Handling conversation for comment ${commentId} on PR #${prNumber}`);

  const gh = new GitHubHelper(token, repo);

  // Fetch the PR for context
  let pr: PRContext;
  try {
    pr = await gh.getPR(prNumber);
  } catch (err) {
    logger.error(`Failed to get PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // Build the conversation thread
  let thread: ConversationMessage[] = [];
  let filePath: string | undefined;
  let diffHunk: string | undefined;
  const mentionHandle = config.conversation.mentionHandle;

  if (isReviewComment) {
    // For review comments, fetch the full comment thread on that file/line
    const threadResult = await gatherReviewCommentThread(gh, prNumber, commentId, mentionHandle);
    thread = threadResult.thread;
    filePath = threadResult.filePath;
    diffHunk = threadResult.diffHunk;
  } else {
    // For issue comments, fetch the comment thread on the PR
    const threadResult = await gatherIssueCommentThread(gh, prNumber, commentId, mentionHandle);
    thread = threadResult.thread;
  }

  if (thread.length === 0) {
    logger.warn('No conversation thread found — skipping');
    return;
  }

  // Get the user's latest message for intent detection
  const lastUserMessage = [...thread].reverse().find((m) => m.role === 'user');
  const intent = lastUserMessage ? detectIntent(lastUserMessage.body) : 'general';

  const context: ConversationContext = {
    filePath,
    diffHunk,
    thread,
    prContext: pr,
    intent,
  };

  // Run through the engine
  const engine = new ReviewEngine(config, token, repo, learningStore);
  try {
    if (signal?.aborted) return;

    const response = await engine.runConversation(context, undefined, tempDir);

    if (signal?.aborted) return;

    // Post the response as a reply
    if (isReviewComment) {
      await postReviewCommentReply(gh, prNumber, commentId, response);
    } else {
      await postIssueCommentReply(gh, prNumber, response);
    }

    logger.info(`Conversation response posted for comment ${commentId} on PR #${prNumber}`);
  } catch (err) {
    logger.error(
      `Conversation failed for comment ${commentId}: ${err instanceof Error ? err.message : err}`,
    );
    // Post error response
    const errorMsg =
      '❌ I encountered an error processing your request. Please try again or rephrase your question.';
    try {
      if (isReviewComment) {
        await postReviewCommentReply(gh, prNumber, commentId, errorMsg);
      } else {
        await postIssueCommentReply(gh, prNumber, errorMsg);
      }
    } catch {
      logger.warn('Failed to post error response comment');
    }
  } finally {
    await engine.cleanup();
  }
}

// ─── Thread Gathering Helpers ────────────────────────────────────

interface ReviewCommentThread {
  thread: ConversationMessage[];
  filePath?: string;
  diffHunk?: string;
}

interface IssueCommentThread {
  thread: ConversationMessage[];
}

/**
 * Gather the full review comment thread for a given comment.
 * Fetches all review comments on the PR and filters by thread.
 *
 * @param gh - GitHub API helper instance.
 * @param prNumber - PR number.
 * @param commentId - Triggering review comment ID.
 * @param mentionHandle - Bot mention handle.
 * @returns Object containing conversation messages, file path, and diff hunk.
 */
async function gatherReviewCommentThread(
  gh: GitHubHelper,
  prNumber: number,
  commentId: number,
  mentionHandle: string,
): Promise<ReviewCommentThread> {
  try {
    // Fetch all review comments on the PR
    const allComments = (await gh.listReviewComments(prNumber)) as Array<{
      id: number;
      body: string;
      path?: string;
      diff_hunk?: string;
      in_reply_to_id?: number;
      user?: { login?: string };
    }>;

    // Find the triggering comment
    const triggerComment = allComments.find((c) => c.id === commentId);
    if (!triggerComment) {
      return { thread: [] };
    }

    // Determine the root comment (for threaded replies)
    const rootId = triggerComment.in_reply_to_id || triggerComment.id;

    // Collect all comments in the thread
    const threadComments = allComments
      .filter((c) => c.id === rootId || c.in_reply_to_id === rootId)
      .sort((a, b) => a.id - b.id);

    const thread: ConversationMessage[] = threadComments.map((c) => ({
      role: isBotComment(c.user?.login, mentionHandle) ? ('assistant' as const) : ('user' as const),
      body: stripMention(c.body, mentionHandle),
      author: c.user?.login,
    }));

    return {
      thread,
      filePath: triggerComment.path,
      diffHunk: triggerComment.diff_hunk,
    };
  } catch (err) {
    new Logger('Conversation').warn(
      `Failed to gather review comment thread: ${err instanceof Error ? err.message : err}`,
    );
    return { thread: [] };
  }
}

/**
 * Gather the issue comment thread for a given comment.
 * Fetches recent issue comments on the PR.
 *
 * @param gh - GitHub API helper instance.
 * @param prNumber - PR number.
 * @param commentId - Triggering issue comment ID.
 * @param mentionHandle - Bot mention handle.
 * @returns Object containing context conversation messages.
 */
async function gatherIssueCommentThread(
  gh: GitHubHelper,
  prNumber: number,
  commentId: number,
  mentionHandle: string,
): Promise<IssueCommentThread> {
  try {
    const allComments = (await gh.listComments(prNumber)) as Array<{
      id: number;
      body: string;
      user?: { login?: string };
    }>;

    // Find comments around the triggering comment for thread context
    const triggerIdx = allComments.findIndex((c) => c.id === commentId);
    if (triggerIdx === -1) {
      return { thread: [] };
    }

    // Take up to 5 recent comments before the trigger + the trigger itself
    const contextStart = Math.max(0, triggerIdx - 5);
    const contextComments = allComments.slice(contextStart, triggerIdx + 1);

    const thread: ConversationMessage[] = contextComments.map((c) => ({
      role: isBotComment(c.user?.login, mentionHandle) ? ('assistant' as const) : ('user' as const),
      body: stripMention(c.body, mentionHandle),
      author: c.user?.login,
    }));

    return { thread };
  } catch (err) {
    new Logger('Conversation').warn(
      `Failed to gather issue comment thread: ${err instanceof Error ? err.message : err}`,
    );
    return { thread: [] };
  }
}

// ─── Comment Posting Helpers ─────────────────────────────────────

/**
 * Post a reply to a review comment thread.
 *
 * @param gh - GitHub API helper instance.
 * @param prNumber - PR number.
 * @param commentId - Comment ID to reply to.
 * @param body - Message body of the reply.
 */
async function postReviewCommentReply(
  gh: GitHubHelper,
  prNumber: number,
  commentId: number,
  body: string,
): Promise<void> {
  await gh.createReviewCommentReply(prNumber, commentId, body);
}

/**
 * Post a reply as an issue comment on the PR.
 *
 * @param gh - GitHub API helper instance.
 * @param prNumber - PR number.
 * @param body - Message body of the comment.
 */
async function postIssueCommentReply(
  gh: GitHubHelper,
  prNumber: number,
  body: string,
): Promise<void> {
  await gh.postComment(prNumber, body);
}

// ─── Utility Helpers ─────────────────────────────────────────────

/**
 * Check if a comment author is the bot.
 *
 * @param login - Author login string.
 * @param mentionHandle - Bot mention handle.
 * @returns True if author is recognized as bot, false otherwise.
 */
function isBotComment(login: string | undefined, mentionHandle: string): boolean {
  if (!login) return false;
  const cleanHandle = mentionHandle.replace(/^@/, '').toLowerCase();
  const lowerLogin = login.toLowerCase();
  return (
    lowerLogin.endsWith('[bot]') ||
    lowerLogin === cleanHandle ||
    lowerLogin === `${cleanHandle}[bot]`
  );
}

/**
 * Strip the @mention handle from a comment body.
 *
 * @param body - Text content of comment.
 * @param mentionHandle - Mention handle to strip.
 * @returns Text with mention handle removed.
 */
function stripMention(body: string, mentionHandle: string): string {
  const cleanHandle = mentionHandle.replace(/^@/, '');
  const escaped = cleanHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`@${escaped}\\s*`, 'gi');
  return body.replace(regex, '').trim();
}
