import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs';

export async function runFix(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
  repo: string,
  token: string,
): Promise<void> {
  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for fix');
    return;
  }

  const comments = await gh.getIssueComments(prNumber);
  const iteration = comments.filter((c) => c.body.includes('<!-- autofix-review -->')).length;

  if (iteration >= config.maxIterations) {
    core.warning(`Max iterations reached (${config.maxIterations}). Needs manual review.`);
    await gh.setLabels(prNumber, ['autofix:needs-manual-review'], ['autofix', 'autofix:needs-fix']);
    return;
  }

  const pr = await gh.getPR(prNumber);
  const contextMarkdown = await gh.gatherContext({ prNumber });

  const fixResult = await engine.runFix(prNumber, iteration, contextMarkdown);

  let changesMade = false;
  if (fixResult.changesMade) {
    exec.exec('git', ['add', '-A']);
    exec.exec('git', ['commit', '-m', `fix: address review feedback (iteration ${iteration + 1})`]);
    exec.exec('git', ['push', 'origin', pr.headRef]);
    changesMade = true;
  }

  if (inputs.runChecksAfterFix && changesMade) {
    core.info('Running verification commands...');
    const checkCommands = inputs.runChecksAfterFix.split('&&').map((c) => c.trim());
    for (const cmd of checkCommands) {
      try {
        await exec.exec(cmd, []);
      } catch (error) {
        core.warning(`Verification command failed: ${cmd} — ${String(error)}`);
      }
    }
  }

  await gh.removeLabel(prNumber, 'autofix:needs-fix');

  core.setOutput('changes_made', String(changesMade));
}

export async function runAutofixLoop(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
  repo: string,
  token: string,
): Promise<void> {
  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for autofix loop');
    return;
  }

  let approved = false;

  for (let i = 0; i < config.maxIterations; i++) {
    core.info(`=== Autofix iteration ${i + 1}/${config.maxIterations} ===`);

    const pr = await gh.getPR(prNumber);
    const result = await engine.reviewPR(pr);

    if (result.verdict.ready && result.stats.critical === 0 && result.stats.important === 0) {
      core.info('PR approved — all issues resolved');
      approved = true;
      break;
    }

    await gh.postOrUpdateComment(
      prNumber,
      '<!-- autofix-review -->',
      `## Autofix Review (Iteration ${i + 1}/${config.maxIterations})\n\n${result.summary}`,
    );

    const contextMarkdown = await gh.gatherContext({ prNumber });
    const fixResult = await engine.runFix(prNumber, i, contextMarkdown);

    if (!fixResult.changesMade) {
      core.info('Fix agent made no changes — stopping loop');
      break;
    }

    exec.exec('git', ['add', '-A']);
    exec.exec('git', ['commit', '-m', `fix: autofix iteration ${i + 1}`]);
    exec.exec('git', ['push', 'origin', pr.headRef]);

    await gh.postOrUpdateComment(
      prNumber,
      '<!-- autofix-status -->',
      `Fix applied (iteration ${i + 1}). Waiting for review...`,
    );
  }
}

async function resolvePrNumber(): Promise<number | null> {
  const prNumberInput = core.getInput('pr-number');
  if (prNumberInput) {
    return Number.parseInt(prNumberInput, 10);
  }
  const fromIssue = github.context.payload.issue?.number;
  const fromPR = github.context.payload.pull_request?.number;
  return fromPR || fromIssue || null;
}
