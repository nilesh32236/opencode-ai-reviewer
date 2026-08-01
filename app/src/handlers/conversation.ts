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

/** Raw review comment shape used across window fetches and direct by-id fetches. */
interface ThreadComment {
  id: number;
  body: string;
  path?: string;
  diff_hunk?: string;
  in_reply_to_id?: number;
  user?: { login?: string };
}

/**
 * Gather the full review comment thread for a given comment.
 * Fetches all review comments on the PR (bounded window) and reconstructs the
 * whole thread subtree: every comment that directly or transitively replies to
 * a comment in the trigger's ancestor chain (siblings and nested branches), so
 * prior bot/user turns are never dropped. Comments outside the window are
 * fetched directly by ID so the conversation is never silently skipped.
 *
 * Exported for unit testing.
 *
 * @param gh - GitHub API helper instance.
 * @param prNumber - PR number.
 * @param commentId - Triggering review comment ID.
 * @param mentionHandle - Bot mention handle.
 * @returns Object containing conversation messages, file path, and diff hunk.
 */
export async function gatherReviewCommentThread(
  gh: PlatformAdapter,
  prNumber: number,
  commentId: number,
  mentionHandle: string,
): Promise<ReviewCommentThread> {
  try {
    // Fetch review comments in ascending order across a bounded window; comments
    // outside the window are recovered by the direct-fetch fallback below.
    const rawComments = (await gh.listReviewComments(prNumber, {
      perPage: 100,
      maxPages: 5,
      direction: 'asc',
    })) as unknown as ThreadComment[];

    // Index once for O(1) lookups (avoids repeated rawComments.find in loops).
    const byId = new Map<number, ThreadComment>();
    for (const c of rawComments) {
      if (typeof c.id === 'number') byId.set(c.id, c);
    }

    // Walk the in_reply_to_id chain from the trigger up to the root with a cycle
    // guard (in_reply_to_id comes from external API data and may be malformed).
    const chain: ThreadComment[] = [];
    const visited = new Set<number>();
    let currentId: number | undefined = commentId;
    let missingId: number | undefined;
    while (currentId) {
      const comment = byId.get(currentId);
      if (!comment) {
        missingId = currentId;
        break;
      }
      if (visited.has(currentId)) break;
      visited.add(currentId);
      chain.unshift(comment);
      currentId = comment.in_reply_to_id;
    }

    // The trigger or an ancestor fell outside the window: fetch the missing
    // chain by ID so a deep/old thread is never silently truncated.
    if (missingId !== undefined) {
      const missing: ThreadComment[] = [];
      let ancestorId: number | undefined = missingId;
      while (ancestorId) {
        if (visited.has(ancestorId)) break;
        visited.add(ancestorId);
        const comment = (await gh.getReviewComment(
          prNumber,
          ancestorId,
        )) as unknown as ThreadComment;
        missing.push(comment);
        byId.set(comment.id, comment);
        ancestorId = comment.in_reply_to_id;
      }
      // missing is leaf-to-root; prepend reversed to keep the chain root-first.
      chain.unshift(...missing.reverse());
    }

    if (chain.length === 0) {
      return { thread: [] };
    }

    // Include the whole thread subtree: every windowed comment that directly or
    // transitively replies to a comment in the ancestor chain (preserving sibling
    // replies and nested branches the old root+direct-replies logic kept). The
    // chain itself may hold direct-fetched comments outside the window, so the
    // final list is resolved through byId and sorted ascending by id.
    const threadIds = new Set<number>(chain.map((c) => c.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of rawComments) {
        if (c.in_reply_to_id === undefined) continue;
        if (threadIds.has(c.in_reply_to_id) && !threadIds.has(c.id)) {
          threadIds.add(c.id);
          changed = true;
        }
      }
    }
    const threadComments = [...threadIds]
      .map((id) => byId.get(id))
      .filter((c): c is ThreadComment => c !== undefined)
      .sort((a, b) => a.id - b.id);

    const filePath = chain[0]?.path;
    const diffHunk = chain.find((c) => c.diff_hunk)?.diff_hunk;

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
 * Fetches recent issue comments on the PR (bounded window). When the triggering
 * comment is older than the window it is fetched directly by ID so the
 * conversation is never silently skipped.
 *
 * Exported for unit testing.
 *
 * @param gh - GitHub API helper instance.
 * @param prNumber - PR number.
 * @param commentId - Triggering issue comment ID.
 * @param mentionHandle - Bot mention handle.
 * @returns Object containing context conversation messages.
 */
export async function gatherIssueCommentThread(
  gh: PlatformAdapter,
  prNumber: number,
  commentId: number,
  mentionHandle: string,
): Promise<IssueCommentThread> {
  try {
    // Fetch issue comments in ascending order across a bounded window; comments
    // outside the window are recovered by the direct-fetch fallback below.
    const allComments = (await gh.listComments(prNumber, {
      perPage: 100,
      maxPages: 5,
      direction: 'asc',
    })) as Array<{
      id: number;
      body: string;
      user?: { login?: string };
    }>;

    // Find comments around the triggering comment for thread context.
    const triggerIdx = allComments.findIndex((c) => c.id === commentId);

    let contextComments: Array<{ id: number; body: string; user?: { login?: string } }>;
    if (triggerIdx === -1) {
      // The trigger is older than the bounded window — fetch it by ID and build
      // a minimal thread so the conversation is never silently skipped.
      const triggerComment = await gh.getIssueComment(prNumber, commentId);
      contextComments = [triggerComment];
    } else {
      // Take up to 5 recent comments before the trigger + the trigger itself.
      const contextStart = Math.max(0, triggerIdx - 5);
      contextComments = allComments.slice(contextStart, triggerIdx + 1);
    }

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
