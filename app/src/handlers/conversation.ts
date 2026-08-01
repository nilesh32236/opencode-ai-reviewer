import type {
  AgentConfig,
  ConversationContext,
  ConversationMessage,
  LearningStore,
  PRContext,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import {
  GitHubHelper,
  GitLabAdapter,
  Logger,
  ReviewEngine,
  detectIntent,
} from '@opencode-pr-agent/lib';

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

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);

  // Fetch the PR for context
  let pr: PRContext;
  try {
    pr = await gh.getMR(prNumber);
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
  const engine = new ReviewEngine(config, gh, learningStore);
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
  gh: PlatformAdapter,
  prNumber: number,
  commentId: number,
  mentionHandle: string,
): Promise<ReviewCommentThread> {
  try {
    // Fetch review comments in ascending order across a bounded window so the
    // triggering comment is found even when it is older than the newest page.
    const rawComments = (await gh.listReviewComments(prNumber, {
      perPage: 100,
      maxPages: 20,
      direction: 'asc',
    })) as Array<{
      id: number;
      body: string;
      path?: string;
      diff_hunk?: string;
      in_reply_to_id?: number;
      user?: { login?: string };
    }>;

    const triggerComment = rawComments.find((c) => c.id === commentId);

    let threadComments: Array<{
      id: number;
      body: string;
      path?: string;
      user?: { login?: string };
    }>;
    let filePath: string | undefined;
    let diffHunk: string | undefined;

    if (triggerComment) {
      // Reconstruct the full thread by walking the in_reply_to_id chain from the
      // trigger up to the root, preserving multi-level reply chains instead of
      // only matching direct replies to the root.
      const chainIds = new Set<number>();
      let currentId: number | undefined = commentId;
      while (currentId) {
        chainIds.add(currentId);
        currentId = rawComments.find((c) => c.id === currentId)?.in_reply_to_id;
      }
      threadComments = rawComments.filter((c) => chainIds.has(c.id));
      filePath = triggerComment.path;
      diffHunk = triggerComment.diff_hunk;
    } else {
      // The trigger comment is older than the bounded window — fetch it directly
      // by ID and walk its in_reply_to_id chain so the conversation is never
      // silently skipped.
      const chain: Array<{
        id: number;
        body: string;
        path?: string;
        in_reply_to_id?: number;
        user?: { login?: string };
      }> = [];
      let currentId: number | undefined = commentId;
      while (currentId) {
        const comment = await gh.getReviewComment(prNumber, currentId);
        chain.push(comment);
        currentId = comment.in_reply_to_id;
      }
      filePath = chain[0]?.path;
      threadComments = chain.reverse();
    }

    if (threadComments.length === 0) {
      return { thread: [] };
    }

    const thread: ConversationMessage[] = threadComments.map((c) => ({
      role: isBotComment(c.user?.login, mentionHandle) ? ('assistant' as const) : ('user' as const),
      body: stripMention(c.body, mentionHandle),
      author: c.user?.login,
    }));

    return {
      thread,
      filePath,
      diffHunk,
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
  gh: PlatformAdapter,
  prNumber: number,
  commentId: number,
  mentionHandle: string,
): Promise<IssueCommentThread> {
  try {
    // Fetch issue comments in ascending order across a bounded window so the
    // triggering comment is located even when it is not among the newest.
    const allComments = (await gh.listComments(prNumber, {
      perPage: 100,
      maxPages: 20,
      direction: 'asc',
    })) as Array<{
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
  gh: PlatformAdapter,
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
  gh: PlatformAdapter,
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
