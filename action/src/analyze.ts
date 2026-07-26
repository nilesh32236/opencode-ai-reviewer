import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import { parseAnalysisPlan } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { sanitize } from './utils.js';

/**
 * Execute an issue analysis: gather issue context, run the analysis engine,
 * parse blocking questions, apply appropriate labels, and post the plan.
 * @param _inputs - Parsed action inputs.
 * @param _config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo).
 * @param _token - GitHub authentication token.
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
    const parsed = parseAnalysisPlan(planMarkdown);

    await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);

    if (parsed.hasBlockingQuestions) {
      const questionsBody = [
        '## ❓ Questions Before Proceeding',
        '',
        'I have analyzed this issue but need clarification before starting implementation.',
        'Please answer the following questions by replying to this comment:',
        '',
        ...parsed.blockingQuestions.map((q: string, i: number) => `**Q${i + 1}:** ${q}`),
        '',
        '---',
        '*Once these are answered, comment `/fix` to start the implementation.*',
      ].join('\n');

      await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-questions -->', questionsBody);

      await gh.ensureLabels(['analysis:needs-input']);
      await gh.addLabels(issueNumber, ['analysis:needs-input']);
    } else {
      await gh.ensureLabels(['analysis:ready']);
      await gh.addLabels(issueNumber, ['analysis:ready']);
    }

    core.setOutput('has_blocking_questions', String(parsed.hasBlockingQuestions));
    core.setOutput('confidence_level', parsed.confidenceLevel);
    core.info(`Posted analysis plan for issue #${issueNumber}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(sanitize(`Analysis failed for issue #${issueNumber}: ${message}`));
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- issue-analysis-error -->',
      `❌ **Analysis Failed**: ${message}`,
    );
  }
}
