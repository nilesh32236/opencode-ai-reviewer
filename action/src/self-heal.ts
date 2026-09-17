import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { Logger, sanitizeString, validateRefName, withRetry } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import {
  capVerificationOutput,
  describeAbortKind,
  execWithTimeout,
  redactSecrets,
  sanitize,
  scrubVerificationOutput,
} from './utils.js';

/**
 * Maximum CI-log characters forwarded to the LLM after redaction. Bounds
 * prompt size and prevents large env dumps from reaching the provider.
 */
export const MAX_CI_LOGS_CHARS_FOR_LLM = 20_000;

/**
 * Redact CI failure logs before they reach the LLM: masks secret/token
 * patterns (via the shared sanitizer plus generic flag/assignment forms),
 * so build-log env dumps, tokens, and file paths cannot be exfiltrated to
 * the provider or resurface in generated patches, commit messages, or PR
 * bodies. Callers must pass the result — never the raw logs — to the engine.
 * @param logs - Raw CI failure logs.
 * @returns Redacted logs, capped to {@link MAX_CI_LOGS_CHARS_FOR_LLM}.
 */
export function redactCiLogsForLlm(logs: string): string {
  const scrubbed = redactSecrets(sanitizeString(String(logs ?? '')));
  if (scrubbed.length <= MAX_CI_LOGS_CHARS_FOR_LLM) return scrubbed;
  return `${scrubbed.slice(0, MAX_CI_LOGS_CHARS_FOR_LLM)}\n…[truncated ${scrubbed.length - MAX_CI_LOGS_CHARS_FOR_LLM} chars: CI logs capped at ${MAX_CI_LOGS_CHARS_FOR_LLM} chars before LLM]…`;
}

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
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo).
 * @param _token - GitHub authentication token.
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly
 *   and race verification timeouts. Advisory-only: engine calls themselves
 *   are not yet cancellable.
 */
export async function runSelfHeal(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  _repo: string,
  _token: string,
  signal?: AbortSignal,
): Promise<void> {
  // Read CI failure logs from input or from a file. The file path comes from
  // the CI_FAILURE_LOGS_FILE env var, which may be attacker-influenced via
  // workflow injection — so it is confined to GITHUB_WORKSPACE (falling back
  // to /tmp and cwd for local runs) and size-capped before reading. Contents
  // are forwarded to the LLM, so an unconstrained path would exfiltrate
  // arbitrary workspace files (e.g. .env).
  let ciFailureLogs = inputs.ciFailureLogs;
  const logsFilePath = process.env.CI_FAILURE_LOGS_FILE;
  if ((!ciFailureLogs || ciFailureLogs.trim().length === 0) && logsFilePath) {
    try {
      ciFailureLogs = readConstrainedLogFile(logsFilePath);
      core.info(`Read CI failure logs from ${logsFilePath} (${ciFailureLogs.length} bytes)`);
    } catch (err) {
      core.warning(sanitize(`Failed to read CI failure logs from ${logsFilePath}: ${err}`));
    }
  }

  if (!ciFailureLogs || ciFailureLogs.trim().length === 0) {
    core.setFailed('self-heal mode requires ci_failure_logs input or CI_FAILURE_LOGS_FILE env var');
    return;
  }

  // ci_failure_logs must be pre-scrubbed by the workflow author, but
  // defense-in-depth redacts here too: raw logs (env dumps, tokens, paths)
  // are never forwarded verbatim to the external LLM.
  ciFailureLogs = redactCiLogsForLlm(ciFailureLogs);

  const failedStep = inputs.failedStep;
  const failedWorkflow = inputs.failedWorkflow;

  core.info(
    `Self-healing CI failure: workflow="${failedWorkflow || 'unknown'}", step="${failedStep || 'unknown'}"`,
  );

  // Ensure we're on a fix branch
  const runId = process.env.GITHUB_RUN_ID || String(Date.now());
  const branchName = `fix/ci-heal-${runId}`;
  let defaultBranch: string;
  try {
    defaultBranch = await withRetry(() => gh.getDefaultBranch(), {
      operationName: 'self-heal.getDefaultBranch',
    });
  } catch (err) {
    core.setFailed(
      sanitize(`Failed to get default branch: ${err instanceof Error ? err.message : String(err)}`),
    );
    core.setOutput('changes_made', 'false');
    return;
  }

  try {
    validateRefName(branchName);
    validateRefName(defaultBranch);
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
  let aborted = false;

  for (let attempt = 0; attempt < maxHealRetries; attempt++) {
    core.info(`=== Self-heal attempt ${attempt + 1}/${maxHealRetries} ===`);

    if (signal?.aborted) {
      // Signal is advisory-only: engine.runSelfHeal accepts no AbortSignal,
      // so this pre-check cannot cancel an in-flight LLM call. Record the
      // cancellation and break; the post-loop abort gate below fails visibly
      // instead of falling through to push a branch / open a PR.
      const kind = signal.reason === undefined ? 'cancelled' : describeAbortKind(signal.reason);
      lastVerificationError = `Self-heal cancelled before attempt ${attempt + 1} (${kind})`;
      core.warning(sanitize(lastVerificationError));
      aborted = true;
      break;
    }

    // Exception-safe attempt: a single LLM/transient throw must not escape
    // the loop, orphan the heal branch, and skip verification/PR/outputs.
    // Record the message as the verification error (auditable trail) and
    // continue; escalation via setFailed happens only after attempt 3.
    let healResult: Awaited<ReturnType<typeof engine.runSelfHeal>>;
    try {
      healResult = await engine.runSelfHeal(
        ciFailureLogs,
        failedStep,
        failedWorkflow,
        config.timeoutMinutes,
        lastVerificationError,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const kind = describeAbortKind(err);
      lastVerificationError = `Self-heal attempt ${attempt + 1} engine error (${kind}): ${msg}`;
      core.warning(sanitize(lastVerificationError));
      new Logger('SelfHeal').warn('Self-heal engine attempt failed', {
        operation: 'self-heal.run',
        attempt: attempt + 1,
        error: msg,
      });
      if (attempt >= maxHealRetries - 1) {
        core.setFailed(
          sanitize(`Self-heal failed after ${maxHealRetries} attempts: last error: ${msg}`),
        );
        core.setOutput('changes_made', 'false');
        core.setOutput('verification_passed', 'false');
      }
      continue;
    }

    if (!healResult.changesMade) {
      core.info('Self-heal agent made no changes');
      if (attempt === 0) {
        core.setFailed('Self-heal agent could not determine a fix for the CI failure');
        core.setOutput('changes_made', 'false');
        core.setOutput('verification_passed', 'false');
        return;
      }
      break;
    }

    // Commit the changes with a fixed message. The LLM-derived diagnosis is
    // deliberately NOT interpolated here: model output influenced by CI logs
    // could persist leaked secrets/PII into immutable git history (pushed to
    // the heal branch), where sanitize() can never redact it. Diagnosis
    // belongs in the PR body/logs after sanitization, never in git metadata.
    try {
      await exec.exec('git', ['add', '-A']);
      await exec.exec('git', [
        'commit',
        '-m',
        `fix: self-heal CI failure (attempt ${attempt + 1})`,
      ]);
      changesMade = true;
    } catch (err) {
      // Fail loudly: the agent produced a fix but it was lost at commit
      // time. A warn-and-break followed by a silent INFO return would report
      // success despite zero progress (fail-open, hides lost work from
      // branch protection). Escalate visibly so the run is re-triable.
      const msg = `Self-heal attempt ${attempt + 1} commit failed, losing agent-produced changes: ${err instanceof Error ? err.message : String(err)}`;
      core.warning(sanitize(msg));
      new Logger('SelfHeal').warn('Self-heal commit failed', {
        operation: 'self-heal.commit',
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      lastVerificationError = msg;
      core.setFailed(sanitize(msg));
      core.setOutput('changes_made', 'false');
      core.setOutput('verification_passed', 'false');
      return;
    }

    // Run verification — guarded so a harness throw (spawn rejection, OOM,
    // cap bug) is recorded as the attempt error and retried instead of
    // escaping the loop and skipping outputs/PR section.
    core.info('Running verification: pnpm build && typecheck && test && lint');
    let exitCode: number;
    let verifyOutput: string;
    try {
      ({ exitCode, output: verifyOutput } = await runFullVerification(signal));
    } catch (err) {
      lastVerificationError = `Verification harness error: ${err instanceof Error ? err.message : String(err)}`;
      core.warning(sanitize(lastVerificationError));
      new Logger('SelfHeal').warn('Verification harness failed', {
        operation: 'self-heal.verify',
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

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

  // A cancelled run must never fall through to push a branch and open a PR:
  // break preserves changesMade=true, so gate on cancellation explicitly and
  // fail visibly with outputs instead. Also covers a signal that fired during
  // the final in-flight (non-cancellable) engine call, where no pre-check ran.
  if (aborted || signal?.aborted) {
    const kind =
      signal && signal.reason !== undefined ? describeAbortKind(signal.reason) : 'cancelled';
    const message = lastVerificationError ?? `Self-heal cancelled (${kind})`;
    // Report changes_made=false: local commits were never pushed to the heal
    // branch, so downstream automation must not treat unpublished work as
    // progress.
    core.setOutput('changes_made', 'false');
    core.setOutput('verification_passed', 'false');
    core.setFailed(sanitize(message));
    return;
  }

  if (!changesMade) {
    // Never report success with zero progress: set explicit outputs and fail
    // visibly so the run is re-triable instead of silently green. The
    // embedded engine error is capped (~2000 chars, surrogate-safe) so a
    // large message cannot exceed annotation limits.
    core.info('No changes were made by the self-heal agent');
    core.setOutput('changes_made', 'false');
    core.setOutput('verification_passed', 'false');
    const detail = lastVerificationError
      ? Array.from(lastVerificationError).slice(0, 2000).join('')
      : 'the agent produced no committable fix';
    core.setFailed(sanitize(`Self-heal made no progress: ${detail}`));
    return;
  }

  // Push the branch with retry. exec errors carry no `.status`, so withRetry
  // sees status 0: retryUnknownStatus must stay true (the default) or the
  // wrapper never retries transient network failures. Re-pushing the same
  // commits with --force-with-lease is safe to replay.
  try {
    validateRefName(branchName);
    await withRetry(() => exec.exec('git', ['push', 'origin', branchName, '--force-with-lease']), {
      operationName: 'self-heal.pushBranch',
      maxRetries: 2,
      baseDelayMs: 500,
      retryUnknownStatus: true,
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

  const baseBranch = defaultBranch;
  let prUrl = '';
  let prNumber: number | undefined;
  try {
    const result = await withRetry(
      async () => gh.createPR(prTitle, prBody, branchName, baseBranch),
      { operationName: 'self-heal.createPR', maxRetries: 3, baseDelayMs: 1000 },
    );
    prUrl = result?.url || '';
    prNumber = result?.number;
  } catch (err) {
    core.warning(sanitize(`Failed to create PR: ${err instanceof Error ? err.message : err}`));
  }

  if (prNumber) {
    try {
      await gh.addLabels(prNumber, ['autofix', 'self-heal']);
    } catch (err) {
      core.warning(
        sanitize(
          `Failed to label self-heal PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }
  }

  if (prUrl) {
    core.info(`Created self-heal PR: ${prUrl}`);
    core.setOutput('pr_url', prUrl);
  }

  core.setOutput('changes_made', String(changesMade));
  core.setOutput('verification_passed', String(lastVerificationError === undefined));
}

/**
 * Maximum bytes read from a CI failure-logs file. Bounds LLM context and
 * prevents a crafted path from paging huge files into memory.
 */
const MAX_CI_LOGS_BYTES = 1024 * 1024;

/**
 * Read a CI failure-logs file confined to safe directories.
 * Resolves the path and requires containment in GITHUB_WORKSPACE, /tmp, or
 * the current working directory; rejects anything else (including `..`
 * escapes to outside roots) and caps the read at MAX_CI_LOGS_BYTES.
 *
 * @param logsFilePath - Raw CI_FAILURE_LOGS_FILE value.
 * @returns The file contents, truncated to the size cap.
 * @throws {Error} When the path escapes the safe roots or cannot be read.
 */
export function readConstrainedLogFile(logsFilePath: string): string {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const safeRoots = [path.resolve(workspace), path.resolve('/tmp'), path.resolve(process.cwd())];
  const resolved = path.resolve(workspace, logsFilePath);
  const contained = safeRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
  if (!contained) {
    throw new Error(
      `CI_FAILURE_LOGS_FILE must point inside GITHUB_WORKSPACE, /tmp, or the working directory: ${logsFilePath}`,
    );
  }
  // Reject symlinks before following them: statSync/readFileSync follow links,
  // so a planted symlink inside a safe root could otherwise exfiltrate files
  // (e.g. .env/credentials) into the LLM prompt and PR body.
  if (fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`CI_FAILURE_LOGS_FILE must not be a symlink: ${logsFilePath}`);
  }
  const real = fs.realpathSync(resolved);
  const realContained = safeRoots.some(
    (root) => real === root || real.startsWith(`${root}${path.sep}`),
  );
  if (!realContained) {
    throw new Error(`CI_FAILURE_LOGS_FILE resolves outside safe roots: ${logsFilePath}`);
  }
  // Pin the file with an open descriptor before inspecting it: checking
  // metadata and then reading by path (statSync + readFileSync) is a
  // TOCTOU race — the path can be swapped between the two calls. fstatSync
  // on the descriptor observes the same file that is subsequently read.
  const fd = fs.openSync(real, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`CI_FAILURE_LOGS_FILE is not a regular file: ${logsFilePath}`);
    }
    if (stat.size > MAX_CI_LOGS_BYTES) {
      const buf = Buffer.alloc(MAX_CI_LOGS_BYTES);
      fs.readSync(fd, buf, 0, MAX_CI_LOGS_BYTES, 0);
      return buf.toString('utf-8');
    }
    // Small file: read the whole descriptor (never re-open by path, so the
    // validated file and the read file cannot diverge).
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Run full verification suite (build, typecheck, test, lint) as a single pipeline.
 * Each step runs with a per-command timeout (default 5 min) so a hung check
 * fails verification with a clear message instead of blocking the runner
 * (multiplied across 3 heal attempts). Output is byte-capped before it is
 * fed back to the fix engine.
 * @param signal - Optional run-level abort signal composed with each per-command timeout.
 * @returns Object containing exit code (0 for success) and combined stdout/stderr output for diagnosis.
 */
async function runFullVerification(
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  const commands = [
    { program: 'pnpm', args: ['build'], label: 'build' },
    { program: 'pnpm', args: ['typecheck'], label: 'typecheck' },
    { program: 'pnpm', args: ['test'], label: 'test' },
    { program: 'pnpm', args: ['lint'], label: 'lint' },
  ];

  const outputChunks: string[] = [];

  for (const cmd of commands) {
    const { exitCode, output: stepOutput } = await execWithTimeout(cmd.program, cmd.args, {
      signal,
    });

    outputChunks.push(`=== ${cmd.label} (exit: ${exitCode}) ===\n${stepOutput}`);

    if (exitCode !== 0) {
      return {
        exitCode,
        output: scrubVerificationOutput(capVerificationOutput(outputChunks.join('\n\n'))),
      };
    }
  }

  return {
    exitCode: 0,
    output: scrubVerificationOutput(capVerificationOutput(outputChunks.join('\n\n'))),
  };
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
