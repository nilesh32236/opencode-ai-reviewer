import { isValidRepoSlug, validateRefName } from './validation.js';

/**
 * Single owner for the security-sensitive git branch-setup sequence.
 *
 * Previously triplicated across `createAutofixPR` (commands.ts),
 * `handleDocsCommand` (commands.ts), and `createChangelogPR` (changelog.ts):
 * fetch → rev-parse existing-branch check → checkout -B/-b → pull --rebase →
 * push --force-with-lease, with `validateRefName` on every interpolated ref.
 * Only the docs copy handled fork remotes and `startRef` validation, so a
 * future ref-injection or push-scope fix applied to one copy would silently
 * miss the others. All new branch/push flows must use these helpers with a
 * single options object.
 */

/** Minimal `execGit` seam injected by callers (app/ or tests). */
export type ExecGitFn = (
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

/** Options for {@link prepareBranchWorkspace}. */
export interface PrepareBranchWorkspaceOptions {
  /** New branch to create or reuse (validated). */
  branchName: string;
  /** Default branch to rebase onto when no baseRef is given (validated). */
  defaultBranch: string;
  /** Base ref for fresh branches (validated). Defaults to `defaultBranch`. */
  baseRef?: string;
  /** Full `owner/repo` of the PR head (fork detection). */
  headRepoFullName?: string;
  /** Target repo `owner/repo` the workspace was cloned from. */
  repo?: string;
  /** Working directory for git commands. */
  cwd?: string;
  /** Extra env for authenticated git commands. */
  env?: Record<string, string>;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Optional logger (`info`/`warn`). Defaults to no-op. */
  logger?: { info(msg: string): void; warn(msg: string): void };
}

/** Result of {@link prepareBranchWorkspace}. */
export interface BranchWorkspaceResult {
  /** True when the branch already existed on `origin`. */
  branchExists: boolean;
  /** Set to `'fork'` when the base was fetched from a fork remote. */
  forkRemote?: string;
  /** Ref the new branch was started from (fresh-branch case). */
  startRef: string;
  /** Effective base ref used. */
  baseRef: string;
}

/**
 * Fetch, detect, checkout (or create), and rebase a branch workspace.
 * Validates every interpolated ref with `validateRefName` and every fork
 * slug with `isValidRepoSlug` so a hostile branch/repo value can never
 * escape into a refspec, remote URL, or push target.
 *
 * @param execGit - Git execution seam (e.g. `app/src/utils/git.ts#execGit`).
 * @param options - Single options object describing the desired workspace.
 * @returns Workspace result describing existence, fork remote, and start ref.
 */
export async function prepareBranchWorkspace(
  execGit: ExecGitFn,
  options: PrepareBranchWorkspaceOptions,
): Promise<BranchWorkspaceResult> {
  const {
    branchName,
    defaultBranch,
    baseRef: rawBaseRef,
    headRepoFullName,
    repo,
    cwd,
    env,
    signal,
    logger,
  } = options;
  validateRefName(branchName);
  validateRefName(defaultBranch);
  const baseRef = rawBaseRef ?? defaultBranch;
  validateRefName(baseRef);

  const gitOpts = {
    ...(cwd !== undefined ? { cwd } : {}),
    timeout: 120_000,
    ...(env ? { env } : {}),
    ...(signal ? { signal } : {}),
  };

  try {
    await execGit(['fetch', 'origin'], gitOpts);
    // The shallow clone is single-branch: `fetch origin` only updates the
    // default branch. Fetch the target branch into its remote-tracking ref so
    // existing-branch detection and checkout below can reference it.
    await execGit(['fetch', 'origin', `+${branchName}:refs/remotes/origin/${branchName}`], gitOpts);
  } catch (err) {
    logger?.warn(
      `Git fetch failed: ${err instanceof Error ? err.message : String(err)} — continuing with local state`,
    );
  }

  let branchExists = false;
  try {
    await execGit(['rev-parse', '--verify', `origin/${branchName}`], gitOpts);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  // Fork-backed PRs keep the head branch on the fork, not on origin. Resolve
  // the head repo (when it differs from the target repo) and fetch the base
  // from that remote so the checkout/rebase below references a real ref.
  let forkRemote: string | undefined;
  if (headRepoFullName && repo && headRepoFullName !== repo) {
    if (!isValidRepoSlug(headRepoFullName)) {
      logger?.warn(
        `Skipping fork fetch — invalid head repo slug "${headRepoFullName}" — falling back to origin`,
      );
    } else {
      try {
        await execGit(
          ['remote', 'add', 'fork', `https://github.com/${headRepoFullName}.git`],
          gitOpts,
        );
        await execGit(['fetch', 'fork', baseRef], gitOpts);
        forkRemote = 'fork';
        logger?.info(`Fetched base branch ${baseRef} from fork ${headRepoFullName}`);
      } catch (err) {
        logger?.warn(
          `Could not fetch base branch from fork ${headRepoFullName}: ${err instanceof Error ? err.message : String(err)} — falling back to origin`,
        );
      }
    }
  }

  if (!forkRemote) {
    try {
      await execGit(['fetch', 'origin', `+${baseRef}:refs/remotes/origin/${baseRef}`], gitOpts);
    } catch (err) {
      logger?.warn(
        `Could not fetch base branch ${baseRef} from origin: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (branchExists) {
    await execGit(['checkout', '-B', branchName, `origin/${branchName}`], gitOpts);
    logger?.info(`Checked out existing branch ${branchName}`);
    // A depth-1 clone has no merge-base between the existing branch tip and
    // the updated base; deepen so `pull --rebase` can compute the merge-base.
    await execGit(['fetch', '--unshallow', 'origin'], gitOpts);
    if (forkRemote) {
      await execGit(['fetch', '--unshallow', forkRemote], gitOpts);
    }
    await execGit(['pull', '--rebase', forkRemote ?? 'origin', baseRef], gitOpts);
    return {
      branchExists,
      ...(forkRemote ? { forkRemote } : {}),
      startRef: `origin/${branchName}`,
      baseRef,
    };
  }

  const startRef = forkRemote ? `${forkRemote}/${baseRef}` : `origin/${baseRef}`;
  validateRefName(startRef);
  await execGit(['checkout', '-b', branchName, startRef], gitOpts);
  logger?.info(`Created branch ${branchName} from ${startRef}`);
  return { branchExists, ...(forkRemote ? { forkRemote } : {}), startRef, baseRef };
}

/** Options for {@link pushBranchWithLease}. */
export interface PushBranchOptions {
  /** Branch to push (validated). */
  branchName: string;
  /** Working directory for git commands. */
  cwd?: string;
  /** Extra env for authenticated git commands. */
  env?: Record<string, string>;
  /** Abort signal. */
  signal?: AbortSignal;
}

/**
 * Push a branch with `--force-with-lease` after validating the ref name, so
 * push-to-wrong-ref fixes live in one place.
 *
 * @param execGit - Git execution seam.
 * @param options - Single options object with the branch to push.
 */
export async function pushBranchWithLease(
  execGit: ExecGitFn,
  options: PushBranchOptions,
): Promise<void> {
  validateRefName(options.branchName);
  await execGit(['push', 'origin', options.branchName, '--force-with-lease'], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    timeout: 120_000,
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
