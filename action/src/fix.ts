import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import type {
  AgentConfig,
  FixResult,
  GitHubHelper,
  IssueComment,
  PreviousFindingIteration,
  ReviewEngine,
  ReviewResult,
} from '@opencode-pr-agent/lib';
import { validateRunChecksCommand } from './inputs.js';
import type { ActionInputs } from './inputs.js';

export async function runFix(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
): Promise<void> {
  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for fix');
    return;
  }

  const comments = await gh.getIssueComments(prNumber);
  const iteration = comments.filter((c: IssueComment) =>
    c.body.includes('<!-- autofix-review -->'),
  ).length;

  if (iteration >= config.maxIterations) {
    const errorMsg = `Max iterations reached (${config.maxIterations}). Needs manual review.`;
    await gh.setLabels(prNumber, ['autofix:needs-manual-review'], ['autofix', 'autofix:needs-fix']);
    core.setFailed(errorMsg);
    return;
  }

  const pr = await gh.getPR(prNumber);
  const contextMarkdown = await gh.gatherContext({ prNumber });

  const fixResult = await engine.runFix(prNumber, iteration, contextMarkdown, pr);

  if (!fixResult) {
    core.warning('Fix engine returned no result - treating as no changes');
  }

  let changesMade = false;
  if (fixResult?.changesMade) {
    try {
      await exec.exec('git', ['add', '-u']);
      await exec.exec('git', [
        'commit',
        '-m',
        `fix: address review feedback (iteration ${iteration + 1})`,
      ]);
      await exec.exec('git', ['push', 'origin', pr.headRef]);
    } catch (err) {
      core.warning(`Git operations failed: ${err instanceof Error ? err.message : err}`);
    }
    changesMade = true;
  }

  if (inputs.runChecksAfterFix && changesMade) {
    core.info('Running verification commands...');
    const { program, args } = validateRunChecksCommand(
      inputs.runChecksAfterFix,
      inputs.checkAllowlist,
    );

    const maxVerificationRetries = 2;
    for (let v = 0; v <= maxVerificationRetries; v++) {
      const { exitCode, output: checkOutput } = await runVerification(program, args);

      if (exitCode === 0) {
        core.info('Verification passed');
        break;
      }

      if (v < maxVerificationRetries) {
        core.warning(
          `Verification command failed (exit code ${exitCode}). Retrying fix with error output...`,
        );

        const freshPr = await gh.getPR(prNumber);
        const freshContextMarkdown = await gh.gatherContext({ prNumber });
        const retryResult = await engine.runFix(
          prNumber,
          iteration,
          freshContextMarkdown,
          freshPr,
          undefined,
          undefined,
          checkOutput,
        );

        if (retryResult?.changesMade) {
          try {
            await exec.exec('git', ['add', '-u']);
            await exec.exec('git', ['commit', '-m', `fix: verification errors (attempt ${v + 1})`]);
            await exec.exec('git', ['push', 'origin', pr.headRef]);
          } catch (err) {
            core.warning(
              `Git operations during verification retry failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      } else {
        core.warning(
          `Verification command failed (exit code ${exitCode}) after all retries — giving up.`,
        );
      }
    }
  }

  await gh.removeLabel(prNumber, 'autofix:needs-fix');

  core.setOutput('changes_made', String(changesMade ?? false));
}

export async function runFixIssue(
  _inputs: ActionInputs,
  _config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
  repo: string,
  token: string,
): Promise<void> {
  const issueNumber = await resolvePrNumber();
  if (!issueNumber) {
    core.setFailed('Could not determine issue number');
    return;
  }

  // Wall-clock guard: detect when queue wait time has consumed most of the job budget.
  // GITHUB_RUN_STARTED_AT is set by GitHub Actions to the ISO timestamp when the
  // workflow run was queued — not when this job started. This lets us account for
  // time spent waiting in the queue or in earlier job steps.
  const configTimeoutMs = (_config.timeoutMinutes ?? 20) * 60 * 1000;
  const runStartedAt = process.env.GITHUB_RUN_STARTED_AT
    ? new Date(process.env.GITHUB_RUN_STARTED_AT).getTime()
    : Date.now();
  const minRequiredMs = 90_000; // Need at least 90 seconds to attempt a meaningful fix

  core.info(`Fixing issue #${issueNumber}`);

  const branchName = `autofix/issue-${issueNumber}`;

  const existingRef = await exec
    .getExecOutput('git', ['rev-parse', '--verify', branchName], { ignoreReturnCode: true })
    .catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));

  if (existingRef.exitCode === 0) {
    await exec.exec('git', ['checkout', branchName]);
  } else {
    await exec.exec('git', ['checkout', '-b', branchName]);
  }

  const issueContext = await gh.gatherContext({ issueNumber });

  // Check remaining time budget just before calling OpenCode, after setup steps.
  const elapsedMs = Date.now() - runStartedAt;
  const timeLeftMs = configTimeoutMs - elapsedMs;
  if (timeLeftMs < minRequiredMs) {
    const elapsedMin = (elapsedMs / 60_000).toFixed(1);
    const budgetMin = (configTimeoutMs / 60_000).toFixed(0);
    const msg = `Insufficient time remaining to run fix (elapsed: ${elapsedMin}m / budget: ${budgetMin}m, remaining: ${Math.round(timeLeftMs / 1000)}s < ${Math.round(minRequiredMs / 1000)}s required). The job likely waited in the queue too long. Re-trigger the fix with /fix.`;
    core.warning(msg);
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-timeout -->',
        `⏳ **Autofix could not start** — the GitHub Actions runner was busy and this job spent too long in the queue.\n\nPlease comment \`/fix\` again to re-trigger the fix.\n\n---\n*🤖 Posted automatically by opencode-ai-reviewer*`,
      );
    } catch (commentErr) {
      core.warning(
        `Failed to post timeout notice: ${commentErr instanceof Error ? commentErr.message : commentErr}`,
      );
    }
    core.setFailed(msg);
    return;
  }

  // Pass remaining time as the effective timeout for OpenCode so it doesn't
  // overrun the GitHub Actions job budget.
  const remainingTimeoutMinutes = Math.max(1, Math.floor((timeLeftMs - 30_000) / 60_000));

  const fixResult = await engine.runFix(
    issueNumber,
    0,
    issueContext,
    undefined,
    remainingTimeoutMinutes,
  );

  if (!fixResult?.changesMade) {
    core.info('No changes made by fix agent');
    return;
  }

  const hasChanges = await exec
    .getExecOutput('git', ['status', '--porcelain'])
    .then((r) => r.stdout.trim().length > 0)
    .catch(() => false);

  if (!hasChanges) {
    core.info('No file changes to commit');
    return;
  }

  await exec.exec('git', ['add', '-A']);
  await exec.exec('git', ['commit', '-m', `fix: address issue #${issueNumber}`]);
  try {
    await exec.exec('git', ['push', 'origin', branchName, '--force']);
  } catch (err) {
    core.warning(`Git push failed: ${err instanceof Error ? err.message : err}`);
    core.setFailed(`Git push failed: ${err instanceof Error ? err.message : err}`);
  }

  const issue = await gh.getIssue(issueNumber);
  const prTitle = `[Autofix] ${issue.title}`;

  const prBody = `## Fixes #${issueNumber}\n\n${issue.body}\n\n---\n*Auto-generated by opencode-ai-reviewer*`;

  // Ensure the autofix label exists in the repository before referencing it in pr create
  await gh.ensureLabels(['autofix']);

  const baseBranch = github.context.payload.repository?.default_branch || 'main';

  const prUrl = await exec
    .getExecOutput(
      'gh',
      [
        'pr',
        'create',
        '--base',
        baseBranch,
        '--head',
        branchName,
        '--title',
        prTitle,
        '--body',
        prBody,
        '--label',
        'autofix',
        '--repo',
        repo,
      ],
      {
        env: { ...process.env, GH_TOKEN: token } as { [key: string]: string },
      },
    )
    .then((r) => r.stdout.trim())
    .catch((err) => {
      core.warning(`Failed to create PR: ${err instanceof Error ? err.message : err}`);
      return '';
    });

  if (prUrl) {
    core.info(`Created PR: ${prUrl}`);
    core.setOutput('pr_url', prUrl);
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-pr-link -->',
        `🔧 Autofix PR: ${prUrl}`,
      );
    } catch (err) {
      core.warning(`Failed to post autofix comment: ${err instanceof Error ? err.message : err}`);
    }
  }

  core.setOutput('changes_made', 'true');
}

interface IterationRecord {
  iteration: number;
  status: 'approved' | 'fix-applied' | 'needs-fix' | 'no-changes' | 'timeout';
  summary: string;
  critical: number;
  important: number;
  minor: number;
  filesChanged?: string[];
  commitMessage?: string;
  fixSummary?: string;
}

const REVIEW_MARKER = '<!-- autofix-review -->';
const FIX_MARKER = '<!-- autofix-applied -->';

function buildReviewBody(
  history: IterationRecord[],
  maxIterations: number,
  phase: 'reviewing' | 'approved' | 'no-changes' | 'max-iterations',
  current?: ReviewResult,
): string {
  const lines: string[] = ['## 🤖 Autofix Review', ''];
  const currentIter = history.length;

  switch (phase) {
    case 'reviewing':
      lines.push(`**Status:** 🔍 Reviewing (iteration ${currentIter}/${maxIterations})`);
      break;
    case 'approved':
      lines.push('**Status:** ✅ Approved — all issues resolved');
      break;
    case 'no-changes':
      lines.push(
        `**Status:** ℹ️ Fix agent made no changes (iteration ${currentIter}/${maxIterations})`,
      );
      break;
    case 'max-iterations':
      lines.push('**Status:** ⚠️ Manual review required');
      break;
  }

  if (current) {
    if (current.summary) {
      lines.push('', '### Summary', '', current.summary);
    }
    if (current.issues.length > 0) {
      lines.push('', '### Issues Found');
      for (const i of current.issues) {
        lines.push(`- **${i.severity.toUpperCase()}:** ${i.file}:${i.line} — ${i.message}`);
        if (i.suggestion) lines.push(`  > ${i.suggestion}`);
      }
    }
    if (current.strengths.length > 0) {
      lines.push('', '### Strengths');
      for (const s of current.strengths) {
        lines.push(`- ✅ **${s.file}:${s.line}** — ${s.message}`);
      }
    }
  }

  if (history.length > 0) {
    lines.push('', '### Iteration History');
    for (const h of history) {
      let icon: string;
      let detail: string;
      switch (h.status) {
        case 'approved':
          icon = '✅';
          detail = 'All issues resolved';
          break;
        case 'fix-applied':
          icon = '🔧';
          detail = `Fix applied — ${h.critical} critical, ${h.important} important`;
          break;
        case 'needs-fix':
          icon = '❌';
          detail = `${h.critical} critical, ${h.important} important remaining`;
          break;
        case 'no-changes':
          icon = 'ℹ️';
          detail = 'No changes made';
          break;
        case 'timeout':
          icon = '⚠️';
          detail = 'Timed out — changes partially applied';
          break;
      }
      lines.push(`- ${icon} **Iteration ${h.iteration}:** ${detail}`);
    }
  }

  switch (phase) {
    case 'approved':
      lines.push('', '✅ **Ready to merge!**');
      break;
    case 'max-iterations':
      lines.push(
        '',
        `⚠️ **Max iterations reached (${maxIterations}).** This PR needs manual review.`,
      );
      break;
  }

  return lines.join('\n');
}

function buildFixBody(history: IterationRecord[]): string {
  const last = history[history.length - 1];
  const lines: string[] = ['## 🔧 Autofix Applied', ''];

  if (last) {
    lines.push(`**Iteration:** ${last.iteration}`);
    lines.push(`**Files changed:** ${last.filesChanged?.length ?? 0}`);
    if (last.commitMessage) lines.push(`**Commit:** \`${last.commitMessage}\``);
    if (last.filesChanged && last.filesChanged.length > 0) {
      lines.push('', '### Changed Files');
      for (const f of last.filesChanged) {
        lines.push(`- \`${f}\``);
      }
    }
    if (last.fixSummary) {
      lines.push('', '### Fix Details', '', last.fixSummary);
    }
  }

  lines.push(
    '',
    '---',
    '',
    '🤖 The fix agent has applied changes. The PR will be reviewed again on the next iteration.',
  );
  return lines.join('\n');
}

function buildReadyBody(history: IterationRecord[], prNumber: number): string {
  const lines: string[] = ['## ✅ Ready to Merge', ''];
  lines.push(`All issues have been resolved in PR #${prNumber}.`);
  lines.push(
    '',
    'The review agent has approved this PR. A maintainer can merge it at their discretion.',
  );
  if (history.length > 0) {
    lines.push('', '### Summary');
    for (const h of history) {
      if (h.summary) {
        lines.push('', h.summary);
        break;
      }
    }
  }
  return lines.join('\n');
}

export async function runAutofixLoop(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
  _repo: string,
  _token: string,
): Promise<void> {
  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for autofix loop');
    return;
  }

  const history: IterationRecord[] = [];
  const previousFindings: PreviousFindingIteration[] = [];
  let approved = false;
  let exitReason: 'approved' | 'no-changes' | 'git-failure' | 'timeout' | 'exhausted' = 'exhausted';

  const startTime = Date.now();
  const totalTimeoutMs = (config.timeoutMinutes ?? 20) * 60 * 1000;
  const gracePeriodMs = Math.max(30_000, totalTimeoutMs * 0.1);

  for (let i = 0; i < config.maxIterations; i++) {
    const elapsedMs = Date.now() - startTime;
    const timeLeftMs = totalTimeoutMs - elapsedMs;

    if (timeLeftMs <= gracePeriodMs) {
      core.warning(
        `Autofix timeout approaching (remaining: ${Math.round(timeLeftMs / 1000)}s) — shutting down gracefully.`,
      );
      await handleTimeoutGracefully(prNumber, history, i, config, gh);
      return;
    }

    const iterTimeoutMinutes = Math.max(1, Math.round((timeLeftMs - gracePeriodMs) / (60 * 1000)));

    core.info(`=== Autofix iteration ${i + 1}/${config.maxIterations} ===`);

    const pr = await gh.getPR(prNumber);
    const prHeadSha = pr.headSha;
    const result = await engine.reviewPR(
      pr,
      i,
      inputs.reviewPromptFile,
      inputs.reviewPromptExtra,
      iterTimeoutMinutes,
      previousFindings,
    );

    if (
      !result ||
      (!result.summary && result.issues.length === 0 && result.strengths.length === 0)
    ) {
      core.warning(`Review result empty in iteration ${i + 1} — treating as failure`);
      const entry: IterationRecord = {
        iteration: i + 1,
        status: 'needs-fix',
        summary: 'Review returned no meaningful content',
        critical: 0,
        important: 0,
        minor: 0,
      };
      history.push(entry);
      exitReason = 'no-changes';
      break;
    }

    const entry: IterationRecord = {
      iteration: i + 1,
      status: 'approved',
      summary: result.summary,
      critical: result.stats?.critical ?? 0,
      important: result.stats?.important ?? 0,
      minor: result.stats?.minor ?? 0,
    };

    if (result.verdict.ready && result.stats.critical === 0 && result.stats.important === 0) {
      core.info('PR approved — all issues resolved');
      approved = true;
      exitReason = 'approved';
      entry.status = 'approved';
      history.push(entry);

      await gh.setLabels(prNumber, ['autofix:ready'], ['autofix', 'autofix:needs-fix']);
      await gh.createComment(prNumber, buildReadyBody(history, prNumber));
      core.info('Posted ready-to-merge notification');
      break;
    }

    entry.status = 'needs-fix';
    entry.summary = result.summary;
    history.push(entry);
    try {
      await gh.postOrUpdateComment(
        prNumber,
        REVIEW_MARKER,
        buildReviewBody(history, config.maxIterations, 'reviewing', result),
      );
    } catch (err) {
      core.warning(`Failed to post review comment: ${err instanceof Error ? err.message : err}`);
    }

    const contextMarkdown = await gh.gatherContext({ prNumber });
    const fixResult = await engine.runFix(
      prNumber,
      i,
      contextMarkdown,
      pr,
      iterTimeoutMinutes,
      result.issues,
    );

    if (!fixResult.changesMade) {
      core.info('Fix agent made no changes — stopping loop');
      const currentEntry = history[history.length - 1];
      currentEntry.status = 'no-changes';
      exitReason = 'no-changes';
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_MARKER,
          buildReviewBody(history, config.maxIterations, 'no-changes', result),
        );
      } catch (err) {
        core.warning(
          `Failed to post no-changes comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      break;
    }

    const currentEntry = history[history.length - 1];
    currentEntry.status = 'fix-applied';
    currentEntry.filesChanged = fixResult.filesChanged;
    currentEntry.fixSummary = fixResult.summary;

    const commitMsg = `fix: autofix iteration ${i + 1}`;
    try {
      await exec.exec('git', ['add', '-u']);
      await exec.exec('git', ['commit', '-m', commitMsg]);
      await exec.exec('git', ['push', 'origin', pr.headRef]);
      currentEntry.commitMessage = commitMsg;

      previousFindings.push({
        iteration: i + 1,
        issues: result.issues,
        fixSummary: fixResult.summary,
        filesChanged: fixResult.filesChanged,
        headSha: prHeadSha,
      });
    } catch (err) {
      core.warning(
        `Git operations failed in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
      );
      exitReason = 'git-failure';
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_MARKER,
          buildReviewBody(history, config.maxIterations, 'reviewing', result),
        );
      } catch (postErr) {
        core.warning(
          `Failed to post recovery comment: ${postErr instanceof Error ? postErr.message : postErr}`,
        );
      }
      break;
    }

    try {
      await gh.postOrUpdateComment(prNumber, FIX_MARKER, buildFixBody(history));
    } catch (err) {
      core.warning(`Failed to post fix comment: ${err instanceof Error ? err.message : err}`);
    }

    if (inputs.runChecksAfterFix) {
      core.info('Running verification commands...');
      const { program, args } = validateRunChecksCommand(
        inputs.runChecksAfterFix,
        inputs.checkAllowlist,
      );

      const maxVerificationRetries = 2;
      for (let v = 0; v <= maxVerificationRetries; v++) {
        const { exitCode, output: checkOutput } = await runVerification(program, args);

        if (exitCode === 0) {
          core.info('Verification passed');
          break;
        }

        core.warning(
          `Verification failed (exit code ${exitCode}) in attempt ${v + 1}/${maxVerificationRetries + 1}. Output length: ${checkOutput.length} bytes`,
        );

        if (v < maxVerificationRetries) {
          core.info(
            `Feeding verification error to fix engine (retry ${v + 1}/${maxVerificationRetries})...`,
          );
          const prAgain = await gh.getPR(prNumber);
          const freshContextMarkdown = await gh.gatherContext({ prNumber });
          const retryResult = await engine.runFix(
            prNumber,
            i,
            freshContextMarkdown,
            prAgain,
            iterTimeoutMinutes,
            result.issues,
            checkOutput,
          );

          if (!retryResult.changesMade) {
            core.info('Fix agent made no changes to address verification errors');
            break;
          }

          try {
            await exec.exec('git', ['add', '-u']);
            await exec.exec('git', ['commit', '-m', `fix: verification errors (attempt ${v + 1})`]);
            await exec.exec('git', ['push', 'origin', pr.headRef]);
          } catch (err) {
            core.warning(
              `Git operations failed during verification retry: ${err instanceof Error ? err.message : err}`,
            );
            break;
          }
        }
      }
    }
  }

  if (!approved) {
    await gh.setLabels(prNumber, ['autofix:needs-manual-review'], ['autofix', 'autofix:needs-fix']);

    // Only post max-iterations comment if we actually exhausted all iterations.
    // Other exit reasons (no-changes, git-failure) already posted their own comments.
    if (exitReason === 'exhausted') {
      try {
        await gh.createComment(
          prNumber,
          `<!-- autofix-max-iterations -->\n\n${buildReviewBody(history, config.maxIterations, 'max-iterations')}`,
        );
      } catch (err) {
        core.warning(
          `Failed to post max-iterations comment: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const reasonMsg =
      exitReason === 'no-changes'
        ? 'Fix agent could not resolve the issues automatically.'
        : exitReason === 'git-failure'
          ? 'Git operations failed during fix application.'
          : `Max iterations reached (${config.maxIterations}) or agent not approved.`;
    const errorMsg = `${reasonMsg} Needs manual review.`;
    core.setFailed(errorMsg);
  }

  core.setOutput('approved', String(approved));
}

async function runVerification(
  program: string,
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  let output = '';
  const execOptions = {
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString();
      },
      stderr: (data: Buffer) => {
        output += data.toString();
      },
    },
    ignoreReturnCode: true,
  };
  const exitCode = await exec.exec(program, args, execOptions);
  return { exitCode, output };
}

async function handleTimeoutGracefully(
  prNumber: number,
  history: IterationRecord[],
  iteration: number,
  config: AgentConfig,
  gh: GitHubHelper,
): Promise<void> {
  const status = await exec.getExecOutput('git', ['status', '--porcelain']);
  const hasChanges = status.stdout.trim().length > 0;

  let commitMessage = '';
  let filesChanged: string[] = [];

  if (hasChanges) {
    try {
      const raw = await exec.getExecOutput('git', ['diff', '--name-only', 'HEAD']);
      filesChanged = raw.stdout.trim().split('\n').filter(Boolean);

      commitMessage = `fix: address review feedback (partial changes due to timeout iteration ${iteration + 1})`;
      await exec.exec('git', ['add', '-u']);
      await exec.exec('git', ['commit', '-m', commitMessage]);

      const pr = await gh.getPR(prNumber);
      await exec.exec('git', ['push', 'origin', pr.headRef]);
      core.info('Successfully pushed partial changes.');
    } catch (err) {
      core.warning(
        `Git push of partial changes failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Update history
  history.push({
    iteration: iteration + 1,
    status: 'timeout',
    summary: 'Workflow execution timed out. Changes partially applied.',
    critical: 0,
    important: 0,
    minor: 0,
    filesChanged,
    commitMessage,
  });

  const commentBody = `<!-- autofix-timeout -->
⚠️ **Autofix Timed Out (limit: ${config.timeoutMinutes} minutes)**

The workflow run has reached its timeout limit.
${hasChanges ? `Some changes were partially applied to ${filesChanged.length} files and pushed to the branch.` : 'No changes were pending or staged.'}

Please run the workflow again to continue applying fixes.`;

  try {
    await gh.postOrUpdateComment(prNumber, '<!-- autofix-timeout -->', commentBody);
  } catch (err) {
    core.warning(`Failed to post timeout comment: ${err instanceof Error ? err.message : err}`);
  }

  core.setFailed(`Autofix execution timed out after ${config.timeoutMinutes} minutes.`);
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
