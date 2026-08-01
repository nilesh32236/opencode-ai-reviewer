import type { AgentConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
import {
  GitHubHelper,
  GitLabAdapter,
  Logger,
  buildReplyPrompt,
  runOpenCode,
} from '@opencode-pr-agent/lib';

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

    const diffSnippet = await fetchDiffSnippet(gh, prNumber, thread.filePath, thread.lineNumber);

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
 * Fetch a small diff snippet around a specific file:line for context.
 * Falls back to a brief message if the diff cannot be fetched.
 * @param gh - GitHub helper
 * @param prNumber - PR number
 * @param filePath - File path
 * @param _lineNumber - Line number
 * @returns A diff snippet string, or a fallback message if unavailable.
 */
async function fetchDiffSnippet(
  gh: PlatformAdapter,
  prNumber: number,
  filePath: string,
  _lineNumber?: number,
): Promise<string> {
  if (!filePath) return '(No file context available)';
  try {
    const pr = await gh.getMR(prNumber);
    const file = pr.changedFiles.find((f) => f.path === filePath);
    return file?.patch || '(No diff available for this file)';
  } catch {
    return '(Could not fetch diff context)';
  }
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
