/**
 * `ExecGitFn` seam over `@actions/exec`, so `lib`'s branch-workspace helpers
 * (`prepareBranchWorkspace`, `commitAndPush`, `commitAndPushWithLease`,
 * `isWorkingTreeClean`, `pushBranchWithLease`) run under the action's exec
 * policy instead of being re-implemented per call site.
 *
 * The action hand-rolled its commit/push sequence at nine sites across
 * `fix.ts`, `docs.ts`, `changelog.ts`, and `self-heal.ts`. The copies had
 * already drifted into live bugs: `docs.ts` pushed without the
 * `ensureLocalBranchForPush` checkout (the detached-HEAD failure from #674),
 * and the clean-tree probe had three different failure directions.
 */
import * as exec from '@actions/exec';
import type { ExecGitFn } from '@opencode-pr-agent/lib';

/** Options accepted by {@link actionExecGit}, matching lib's `ExecGitFn`. */
type ExecGitOpts = {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * Run a git command through `@actions/exec` in the shape lib's branch helpers
 * expect: resolve `{ stdout, stderr }` on exit 0, reject otherwise (the error
 * carries `stdout`/`stderr` for diagnostics).
 *
 * `getExecOutput` is used rather than `exec` because its return value already
 * carries stdout/stderr — the branch helpers read `status --porcelain` and
 * `rev-parse` output, and `exec` only streams it.
 * @param args - Git arguments.
 * @param opts - Working directory / timeout / env / signal.
 * @returns The command's raw stdout and stderr.
 */
export const actionExecGit: ExecGitFn = async (args, opts) => {
  const { exitCode, stdout, stderr } = await runGit(args, opts);
  if (exitCode !== 0) {
    const err = new Error(`git ${args.join(' ')} failed with exit code ${exitCode}`) as Error & {
      stdout?: string;
      stderr?: string;
    };
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  return { stdout, stderr };
};

/**
 * Same command execution as {@link actionExecGit} but returns the exit code
 * instead of throwing, for callers that branch on it.
 * @param args - Git arguments.
 * @param opts - Working directory / timeout / env / signal.
 * @returns The exit code plus the command's raw stdout and stderr.
 */
export async function actionExecGitRaw(
  args: string[],
  opts: ExecGitOpts = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runGit(args, opts);
}

async function runGit(
  args: string[],
  opts: ExecGitOpts,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return exec.getExecOutput('git', args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env as Record<string, string> } : {}),
    ignoreReturnCode: true,
  });
}
