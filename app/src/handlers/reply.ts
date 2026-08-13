import type { AgentConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
import {
  GitHubHelper,
  GitLabAdapter,
  Logger,
  buildReplyPrompt,
  runOpenCode,
} from '@opencode-pr-agent/lib';
import { truncateToUtf8Bytes } from './pr-review.js';

/**
 * Handle a conversational reply to an AI review comment thread.
 * Fetches thread history, builds a reply prompt, generates an answer,
 * and posts the reply on the PR.
 *
 * @param prNumber - PR number.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param parentCommentId - ID of the AI-originated comment being replied to.
 * @param userCommentBody - The developer's reply/question body.
 */
export async function handleReply(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  parentCommentId: number,
  userCommentBody: string,
): Promise<void> {
  const logger = new Logger('Reply', { repo, prNumber });
  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);

  try {
    const thread = await gh.getReviewCommentThread(parentCommentId, prNumber);

    if (!thread.rootComment.isBot) {
      logger.info('Root comment is not from a bot — skipping reply');
      return;
    }

    const diffSnippet = await fetchDiffSnippet(
      gh,
      prNumber,
      thread.filePath,
      thread.lineNumber,
      thread.commitId,
    );

    const prompt = buildReplyPrompt(
      thread.filePath,
      thread.lineNumber,
      diffSnippet,
      thread.rootComment.body,
      thread.comments,
      userCommentBody,
    );

    logger.info('Generating reply via OpenCode...');
    const result = await runOpenCode(prompt, {
      model: config.conversationModel ?? config.reviewModel,
      timeoutMinutes: 5,
      llm: config.llm,
    });

    if (!result.success || !result.output.trim()) {
      logger.warn('OpenCode returned no output — posting failure reply');
      await gh.replyToReviewComment(
        prNumber,
        parentCommentId,
        "❌ I couldn't generate a reply. Please try again or rephrase.",
      );
      return;
    }

    const replyBody = cleanReplyOutput(result.output);

    await gh.replyToReviewComment(prNumber, parentCommentId, replyBody);
    logger.info('Posted conversational reply to review comment thread');
  } catch (err) {
    logger.error(`Reply handler failed: ${err instanceof Error ? err.message : err}`);
    try {
      await gh.replyToReviewComment(
        prNumber,
        parentCommentId,
        '❌ I encountered an error processing your request. Please try again or rephrase.',
      );
    } catch (replyErr) {
      logger.warn(
        `Failed to post failure reply: ${replyErr instanceof Error ? replyErr.message : replyErr}`,
      );
    }
  }
}

/**
 * Fetch a small snippet of the file the review thread comments on, for context.
 *
 * Prefers fetching just that file's content via the repository contents API at
 * the PR/MR head revision (which also avoids downloading the diff of every
 * other changed file in the PR). Falls back to the file's diff hunk from the
 * full PR context, then to a brief message, when the file is unavailable (e.g.
 * a newly-added file that does not exist at the head revision).
 * @param gh - Platform adapter
 * @param prNumber - PR number
 * @param filePath - File path
 * @param lineNumber - Optional line the thread references; the returned snippet
 * is windowed around it so large files keep the commented region in context.
 * @param ref - Optional git ref (the review comment's commit id) to fetch the
 * file at the PR revision instead of the stale default branch.
 * @returns A snippet string, or a fallback message if unavailable.
 */
async function fetchDiffSnippet(
  gh: PlatformAdapter,
  prNumber: number,
  filePath: string,
  lineNumber?: number,
  ref?: string,
): Promise<string> {
  if (!filePath) return '(No file context available)';

  // Any getFileContent failure (contents-API 403 for files > 1 MiB, rate-limit
  // 403s, transient 5xx) must degrade to the diff-hunk fallback below rather
  // than aborting snippet resolution entirely.
  let content: string | null = null;
  try {
    content = await gh.getFileContent(prNumber, filePath, ref);
  } catch {
    content = null;
  }
  if (content !== null) {
    return windowAroundLine(content, lineNumber);
  }

  try {
    const pr = await gh.getMR(prNumber);
    const file = pr.changedFiles.find((f) => f.path === filePath);
    return file?.patch || '(No diff available for this file)';
  } catch {
    return '(Could not fetch diff context)';
  }
}

/** Context lines on each side of the commented line included in the snippet. */
const CONTEXT_LINES = 20;
/**
 * Byte budget for the windowed snippet. The reply prompt builder truncates the
 * snippet from the start at its own 32KB cap, which would cut off the commented
 * region on large files, so the window is bounded here instead.
 */
const SNIPPET_MAX_BYTES = 24 * 1024;

/**
 * Slice a bounded line window around the commented line so the reply model sees
 * the code under discussion even in files larger than the prompt's snippet cap.
 * Degrades to a byte-budget-bounded window (trimming edges toward the anchor)
 * when an oversized line set would exceed the budget. Without a line anchor the
 * content is returned as-is and the prompt builder's cap still applies.
 * @param content - Full file content.
 * @param lineNumber - Optional line the thread references.
 * @returns The windowed snippet, or the original content when no anchor is set.
 */
function windowAroundLine(content: string, lineNumber?: number): string {
  const lines = content.split('\n');
  if (lineNumber === undefined || lineNumber < 1 || lines.length <= CONTEXT_LINES * 2 + 1) {
    return content;
  }
  let start = Math.max(0, lineNumber - 1 - CONTEXT_LINES);
  let end = Math.min(lines.length, lineNumber - 1 + CONTEXT_LINES + 1);
  let windowLines = lines.slice(start, end);
  // Trim lines from the far edge (farther from the anchor) until the window
  // fits the byte budget, so oversized/minified files still show the region.
  while (Buffer.byteLength(windowLines.join('\n'), 'utf8') > SNIPPET_MAX_BYTES && end - start > 1) {
    const anchorOffset = lineNumber - 1;
    if (anchorOffset - start <= end - 1 - anchorOffset) {
      start++;
    } else {
      end--;
    }
    windowLines = lines.slice(start, end);
  }
  const snippet = windowLines.join('\n');
  return Buffer.byteLength(snippet, 'utf8') <= SNIPPET_MAX_BYTES
    ? snippet
    : truncateToUtf8Bytes(snippet, SNIPPET_MAX_BYTES);
}

/**
 * Remove any JSON-like code fences or artifacts from the OpenCode output,
 * returning the clean markdown reply body.
 * @param output - Raw output string from OpenCode.
 * @returns The trimmed reply body string.
 */
function cleanReplyOutput(output: string): string {
  return output.trim();
}
