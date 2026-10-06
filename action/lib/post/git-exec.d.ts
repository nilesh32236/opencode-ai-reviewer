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
export declare const actionExecGit: ExecGitFn;
/**
 * Same command execution as {@link actionExecGit} but returns the exit code
 * instead of throwing, for callers that branch on it.
 * @param args - Git arguments.
 * @param opts - Working directory / timeout / env / signal.
 * @returns The exit code plus the command's raw stdout and stderr.
 */
export declare function actionExecGitRaw(args: string[], opts?: ExecGitOpts): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
export {};
