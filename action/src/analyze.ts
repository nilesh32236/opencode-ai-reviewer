import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';

/**
 * Execute an issue analysis: gather issue context, run the analysis engine,
 * and post the implementation plan as a comment on the issue.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 */
export async function runAnalyze(
  _inputs: ActionInputs,
  _config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
  _repo: string,
  _token: string,
): Promise<void> {
  const issueNumber =
    github.context.payload.issue?.number || github.context.payload.pull_request?.number;
  if (!issueNumber) {
    core.setFailed('Could not determine issue number from event context');
    return;
  }

  core.info(`Analyzing issue #${issueNumber}`);

  try {
    const issueContext = await gh.gatherContext({ issueNumber });

    const planMarkdown = await engine.runAnalyze(issueNumber, issueContext);

    await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);

    core.info(`Posted analysis plan for issue #${issueNumber}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(`Analysis failed for issue #${issueNumber}: ${message}`);
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- issue-analysis-error -->',
      `❌ **Analysis Failed**: ${message}`,
    );
  }
}
