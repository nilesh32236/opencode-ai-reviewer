import * as fs from 'node:fs';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import { withRetry } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { sanitize } from './utils.js';

/**
 * Run the self-heal workflow: diagnose a CI failure, apply a fix,
 * verify it, and open a PR on a heal branch.
 *
 * Implements a "Detect → Diagnose → Fix → Verify → Learn" loop:
 * 1. Reads CI failure logs from inputs or a file (via CI_FAILURE_LOGS_FILE env var)
 * 2. Runs the engine's runSelfHeal() to diagnose and apply a fix
 * 3. Runs verification (build, typecheck, test, lint) with retry loop
 * 4. Creates a branch and PR with the fix
 *
 * @param inputs - Parsed action inputs (includes ciFailureLogs, failedStep, failedWorkflow).
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 */
export async function runSelfHeal(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
  repo: string,
  token: string,
): Promise<void> {
  // Read CI failure logs from input or from a file
  let ciFailureLogs = inputs.ciFailureLogs;
  const logsFilePath = process.env.CI_FAILURE_LOGS_FILE;
  if ((!ciFailureLogs || ciFailureLogs.trim().length === 0) && logsFilePath) {
    try {
      ciFailureLogs = fs.readFileSync(logsFilePath, 'utf-8');
      core.info(`Read CI failure logs from ${logsFilePath} (${ciFailureLogs.length} bytes)`);
    } catch (err) {
      core.warning(sanitize(`Failed to read CI failure logs from ${logsFilePath}: ${err}`));
    }
  }

  if (!ciFailureLogs || ciFailureLogs.trim().length === 0) {
    core.setFailed('self-heal mode requires ci_failure_logs input or CI_FAILURE_LOGS_FILE env var');
    return;
  }

  const failedStep = inputs.failedStep;
  const failedWorkflow = inputs.failedWorkflow;

  core.info(
    `Self-healing CI failure: workflow="${failedWorkflow || 'unknown'}", step="${failedStep || 'unknown'}"`,
  );

  // Ensure we're on a fix branch
  const runId = process.env.GITHUB_RUN_ID || String(Date.now());
  const branchName = `fix/ci-heal-${runId}`;
  const defaultBranch = await gh.getDefaultBranch();

  try {
    await exec.exec('git', ['checkout', '-b', branchName, `origin/${defaultBranch}`]);
  } catch (err) {
    core.warning(
      sanitize(`Failed to create heal branch: ${err instanceof Error ? err.message : err}`),
    );
    core.setFailed('Could not create heal branch');
    return;
  }

  // Retry loop: diagnose → fix → verify → retry if verification fails
  const maxHealRetries = 3;
  let lastVerificationError: string | undefined;
  let changesMade = false;

  for (let attempt = 0; attempt < maxHealRetries; attempt++) {
    core.info(`=== Self-heal attempt ${attempt + 1}/${maxHealRetries} ===`);

    const healResult = await engine.runSelfHeal(
      ciFailureLogs,
      failedStep,
      failedWorkflow,
      config.timeoutMinutes,
      lastVerificationError,
    );

    if (!healResult.changesMade) {
      core.info('Self-heal agent made no changes');
      if (attempt === 0) {
        core.setFailed('Self-heal agent could not determine a fix for the CI failure');
        return;
      }
      break;
    }

    // Commit the changes
    try {
      await exec.exec('git', ['add', '-A']);
      await exec.exec('git', [
        'commit',
        '-m',
        `fix: self-heal CI failure (attempt ${attempt + 1})${healResult.diagnosis ? ` [${healResult.diagnosis}]` : ''}`,
      ]);
      changesMade = true;
    } catch (err) {
      core.warning(sanitize(`Git commit failed: ${err instanceof Error ? err.message : err}`));
      break;
    }

    // Run verification
    core.info('Running verification: pnpm build && typecheck && test && lint');
    const { exitCode, output: verifyOutput } = await runFullVerification();

    if (exitCode === 0) {
      core.info(`✅ Verification passed on attempt ${attempt + 1}`);
      lastVerificationError = undefined;
      break;
    }

    core.warning(
      sanitize(
        `Verification failed on attempt ${attempt + 1} (exit code ${exitCode}). ${attempt < maxHealRetries - 1 ? 'Retrying...' : 'Giving up.'}`,
      ),
    );
    lastVerificationError = verifyOutput;

    if (attempt >= maxHealRetries - 1) {
      core.warning('Max heal retries reached — pushing partial fix');
    }
  }

  if (!changesMade) {
    core.info('No changes were made by the self-heal agent');
    return;
  }

  // Push the branch with retry
  try {
    await withRetry(() => exec.exec('git', ['push', 'origin', branchName, '--force-with-lease']), {
      maxRetries: 3,
      baseDelayMs: 1000,
    });
  } catch (err) {
    core.warning(sanitize(`Git push failed: ${err instanceof Error ? err.message : err}`));
    core.setFailed('Could not push heal branch');
    return;
  }

  // Ensure labels exist
  try {
    await gh.ensureLabels(['autofix', 'self-heal']);
  } catch {
    /* ignore label creation failure */
  }

  // Build PR body
  const prTitle = `[Self-Heal] Fix CI failure${failedWorkflow ? ` in ${failedWorkflow}` : ''}${failedStep ? ` (${failedStep})` : ''}`;
  const prBody = buildSelfHealPRBody(
    failedWorkflow,
    failedStep,
    lastVerificationError === undefined,
  );

  // Create PR with retry
  const baseBranch = defaultBranch;
  let prUrl = '';
  try {
    prUrl = await withRetry(
      async () => {
        const output = await exec.getExecOutput(
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
            lastVerificationError ? 'self-heal,autofix:needs-manual-review' : 'self-heal,autofix',
            '--repo',
            repo,
          ],
          {
            env: { ...process.env, GH_TOKEN: token } as { [key: string]: string },
          },
        );
        return output.stdout.trim();
      },
      { maxRetries: 3, baseDelayMs: 1000 },
    );
  } catch (err) {
    core.warning(sanitize(`Failed to create PR: ${err instanceof Error ? err.message : err}`));
  }

  if (prUrl) {
    core.info(`Created self-heal PR: ${prUrl}`);
    core.setOutput('pr_url', prUrl);
  }

  core.setOutput('changes_made', String(changesMade));
  core.setOutput('verification_passed', String(lastVerificationError === undefined));
}

/**
 * Run full verification suite (build, typecheck, test, lint) as a single pipeline.
 * @returns Object containing exit code (0 for success) and combined stdout/stderr output for diagnosis.
 */
async function runFullVerification(): Promise<{ exitCode: number; output: string }> {
  const commands = [
    { program: 'pnpm', args: ['build'], label: 'build' },
    { program: 'pnpm', args: ['typecheck'], label: 'typecheck' },
    { program: 'pnpm', args: ['test'], label: 'test' },
    { program: 'pnpm', args: ['lint'], label: 'lint' },
  ];

  const outputChunks: string[] = [];

  for (const cmd of commands) {
    const chunks: Buffer[] = [];
    const exitCode = await exec.exec(cmd.program, cmd.args, {
      listeners: {
        stdout: (data: Buffer) => chunks.push(data),
        stderr: (data: Buffer) => chunks.push(data),
      },
      ignoreReturnCode: true,
    });

    const stepOutput = Buffer.concat(chunks).toString('utf-8');
    outputChunks.push(`=== ${cmd.label} (exit: ${exitCode}) ===\n${stepOutput}`);

    if (exitCode !== 0) {
      return {
        exitCode,
        output: outputChunks.join('\n\n'),
      };
    }
  }

  return { exitCode: 0, output: outputChunks.join('\n\n') };
}

/**
 * Build the PR body for a self-heal PR.
 * @param failedWorkflow - Name of the workflow that failed.
 * @param failedStep - Name of the step that failed.
 * @param verificationPassed - Whether verification passed after the fix.
 * @returns Formatted PR body string.
 */
function buildSelfHealPRBody(
  failedWorkflow?: string,
  failedStep?: string,
  verificationPassed?: boolean,
): string {
  const lines: string[] = [
    '## 🩺 Self-Heal: Automated CI Fix',
    '',
    'This PR was created automatically by the self-healing agent to fix a CI failure.',
    '',
    '### Failure Details',
    '',
  ];

  if (failedWorkflow) {
    lines.push(`- **Workflow:** \`${failedWorkflow}\``);
  }
  if (failedStep) {
    lines.push(`- **Failed Step:** \`${failedStep}\``);
  }

  lines.push('');

  if (verificationPassed) {
    lines.push('### ✅ Verification Status');
    lines.push('');
    lines.push('All verification steps passed:');
    lines.push('- `pnpm build` ✅');
    lines.push('- `pnpm typecheck` ✅');
    lines.push('- `pnpm test` ✅');
    lines.push('- `pnpm lint` ✅');
  } else {
    lines.push('### ⚠️ Verification Status');
    lines.push('');
    lines.push(
      'Some verification steps may have failed. This PR needs manual review before merging.',
    );
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '> **Review required** — This PR was generated autonomously by the self-healing agent. Please review the changes before merging.',
  );
  lines.push('');
  lines.push('*🤖 Posted automatically by opencode-ai-reviewer*');

  return lines.join('\n');
}
