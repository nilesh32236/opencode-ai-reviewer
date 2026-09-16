import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import {
  markAnalysisReady,
  parseAnalysisPlan,
  postBlockingQuestions,
  sanitizeErrorMessage,
  sanitizeMarkdown,
} from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { describeAbortKind, sanitize } from './utils.js';

/**
 * Execute an issue analysis: gather issue context, run the analysis engine,
 * parse blocking questions, apply appropriate labels, and post the plan.
 * @param _inputs - Parsed action inputs (unused, retained for interface compatibility).
 * @param _config - Full agent configuration (unused, retained for interface compatibility).
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 */
export async function runAnalyze(
  _inputs: ActionInputs,
  _config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  _repo: string,
  _token: string,
  signal?: AbortSignal,
): Promise<void> {
  const issueNumber =
    github.context.payload.issue?.number || github.context.payload.pull_request?.number;
  if (!issueNumber) {
    core.setFailed('Could not determine issue number from event context');
    return;
  }

  core.info(`Analyzing issue #${issueNumber}`);

  if (signal?.aborted) {
    // Signal is advisory-only: engine.runAnalyze accepts no AbortSignal,
    // so this pre-check cannot cancel an in-flight LLM call.
    const kind = describeAbortKind(signal.reason);
    core.warning(sanitize(`Analysis cancelled before engine call (${kind}) — skipping`));
    core.setFailed(sanitize(`Analysis cancelled (${kind})`));
    return;
  }

  try {
    const issueContext = await gh.gatherContext({ issueNumber });

    const planMarkdown = await engine.runAnalyze(issueNumber, issueContext);
    const parsed = parseAnalysisPlan(planMarkdown);

    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- issue-analysis-plan -->',
      sanitizeMarkdown(planMarkdown),
    );

    if (parsed.hasBlockingQuestions) {
      await postBlockingQuestions(gh, issueNumber, parsed);
    } else {
      await markAnalysisReady(gh, issueNumber);
    }

    core.setOutput('has_blocking_questions', String(parsed.hasBlockingQuestions));
    core.setOutput('confidence_level', parsed.confidenceLevel);
    core.info(`Posted analysis plan for issue #${issueNumber}`);
  } catch (err) {
    core.warning(
      sanitize(`Analysis failed for issue #${issueNumber}: ${sanitizeErrorMessage(err)}`),
    );
    core.setFailed(sanitize(`Analysis failed for issue #${issueNumber}`));
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- issue-analysis-error -->',
        `❌ **Analysis Failed**: Analysis failed for issue #${issueNumber}. See the action logs for details.`,
      );
    } catch (commentErr) {
      core.warning(
        sanitize(
          `Failed to post analysis error comment: ${commentErr instanceof Error ? commentErr.message : commentErr}`,
        ),
      );
    }
  }
}
