import type {
  AgentConfig,
  ConversationContext,
  ConversationMessage,
  ConversationStateManager,
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
  gatherReviewThread,
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
 * @param stateManager - Optional conversation state manager for context window management.
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
  stateManager?: ConversationStateManager,
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
    const threadResult = await gatherReviewCommentThread(
      gh,
      prNumber,
      commentId,
      mentionHandle,
      signal,
    );
    thread = threadResult.thread;
    filePath = threadResult.filePath;
    diffHunk = threadResult.diffHunk;
  } else {
    // For issue comments, fetch the comment thread on the PR. Accumulate up to
    // the configured sliding-window size so long issue threads can actually
    // engage the sliding-window/summarization machinery instead of always
    // fitting in the window.
    const threadResult = await gatherIssueCommentThread(
      gh,
      prNumber,
      commentId,
      mentionHandle,
      config.conversation.slidingWindowSize,
      signal,
    );
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
    // Include the triggering comment id for review-comment threads so each
    // distinct discussion tracks its own turns/summary instead of sharing a
    // single state across every inline thread on the same file.
    threadId: `${repo}/${prNumber}/${filePath || 'issue'}${isReviewComment ? `#${commentId}` : ''}`,
    repo,
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

    const response = await engine.runConversation(context, undefined, tempDir, stateManager);

    if (signal?.aborted) return;

    // Already-closed threads return '' as a silent no-op — do not post a
    // duplicate close message or an empty comment.
    if (!response) {
      logger.info(`Conversation ${commentId} returned no response — skipping post`);
      return;
    }

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
 * Delegates the bounded-window fetch, in_reply_to_id chain walk with by-id
 * fallback, and subtree expansion to the shared `gatherReviewThread` lib helper
 * (also consumed by GitHubHelper.getReviewCommentThread) so the logic cannot
 * drift between the reply and @mention flows. The window is fetched newest-first
 * ('desc') so freshly-posted @mention triggers and their recent replies land
 * in-window on busy PRs; the output is normalized by the explicit id sort and
 * the chain walk is order-independent via the by-id map.
 *
 * Exported for unit testing.
 *
 * @param gh - GitHub API helper instance.
 * @param prNumber - PR number.
 * @param commentId - Triggering review comment ID.
 * @param mentionHandle - Bot mention handle.
 * @param signal - Optional AbortSignal to cancel the underlying API requests.
 * @returns Object containing conversation messages, file path, and diff hunk.
 */
export async function gatherReviewCommentThread(
  gh: PlatformAdapter,
  prNumber: number,
  commentId: number,
  mentionHandle: string,
  signal?: AbortSignal,
): Promise<ReviewCommentThread> {
  const { chain, comments } = await gatherReviewThread(
    gh,
    prNumber,
    commentId,
    { perPage: 100, maxPages: 5, direction: 'desc' },
    signal,
  );

  if (chain.length === 0) {
    return { thread: [] };
  }

  // Anchor filePath on the first chain comment that carries a path so file
  // context survives when the root is a thread-level comment without one.
  const filePath = chain.find((c) => c.path)?.path ?? chain[chain.length - 1]?.path;
  const diffHunk = chain.find((c) => c.diff_hunk)?.diff_hunk;

  const thread: ConversationMessage[] = comments.map((c) => ({
    role: isBotComment(c.user?.login, mentionHandle) ? ('assistant' as const) : ('user' as const),
    body: stripMention(c.body, mentionHandle),
    author: c.user?.login,
  }));

  return {
    thread,
    filePath,
    diffHunk,
  };
}

/**
 * Gather the issue comment thread for a given comment.
 * Fetches a bounded window of issue comments in ascending order — GitHub's
 * per-issue comments endpoint ignores sort/direction and always returns
 * ascending, and the GitLab adapter maps 'asc' to order_by=created_at&sort — so
 * the triggering comment is always found with the comments preceding it when the
 * PR has few enough comments to fit in the window. When the trigger is older
 * than the window it is fetched directly by ID; if even that fetch fails the
 * newest window comments are used so the @mention is answered rather than
 * silently dropped.
 *
 * Up to `windowSize` comments preceding the trigger are accumulated so issue
 * threads can grow beyond the conversation sliding window and trigger the
 * summarization machinery (a hardcoded 5-comment cap always fit the window and
 * made the feature dead for issue @mentions).
 *
 * Exported for unit testing.
 *
 * @param gh - GitHub API helper instance.
 * @param prNumber - PR number.
 * @param commentId - Triggering issue comment ID.
 * @param mentionHandle - Bot mention handle.
 * @param windowSize - Number of preceding comments to accumulate (defaults to 20).
 * @param signal - Optional AbortSignal to cancel the underlying API requests.
 * @returns Object containing context conversation messages.
 */
export async function gatherIssueCommentThread(
  gh: PlatformAdapter,
  prNumber: number,
  commentId: number,
  mentionHandle: string,
  windowSize = 20,
  signal?: AbortSignal,
): Promise<IssueCommentThread> {
  let allComments: Array<{ id: number; body: string; user?: { login?: string } }> = [];
  try {
    // Ascending order matches what GitHub actually returns for issue comments
    // (the direction param is ignored by the endpoint).
    allComments = (await gh.listComments(
      prNumber,
      {
        perPage: 100,
        maxPages: 5,
        direction: 'asc',
      },
      signal,
    )) as Array<{
      id: number;
      body: string;
      user?: { login?: string };
    }>;
  } catch (err) {
    new Logger('Conversation').warn(
      `Failed to gather issue comment thread: ${err instanceof Error ? err.message : err}`,
    );
    return { thread: [] };
  }

  // Find comments around the triggering comment for thread context.
  const triggerIdx = allComments.findIndex((c) => c.id === commentId);

  let contextComments: Array<{ id: number; body: string; user?: { login?: string } }>;
  if (triggerIdx === -1) {
    // The trigger is older than the bounded window — fetch it by ID and build a
    // minimal thread so the conversation is never silently skipped. If that
    // fetch fails, fall back to the newest window comments so the @mention is
    // still answered rather than dropped.
    let triggerComment: { id: number; body: string; user?: { login?: string } } | undefined;
    try {
      triggerComment = await gh.getIssueComment(prNumber, commentId, signal);
    } catch (err) {
      new Logger('Conversation').warn(
        `Failed to fetch trigger comment ${commentId} by id — falling back to recent window comments: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    if (triggerComment) {
      contextComments = [triggerComment];
    } else {
      contextComments = allComments.slice(-windowSize - 1);
    }
  } else {
    // Ascending window: take up to `windowSize` comments preceding the trigger
    // (older turns) plus the trigger itself, already in chronological order, so
    // long issue threads overflow the sliding window and can be summarized.
    const contextStart = Math.max(0, triggerIdx - windowSize);
    contextComments = allComments.slice(contextStart, triggerIdx + 1);
  }

  const thread: ConversationMessage[] = contextComments.map((c) => ({
    role: isBotComment(c.user?.login, mentionHandle) ? ('assistant' as const) : ('user' as const),
    body: stripMention(c.body, mentionHandle),
    author: c.user?.login,
  }));

  return { thread };
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
