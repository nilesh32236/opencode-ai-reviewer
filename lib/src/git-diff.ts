import * as cp from 'child_process';
import type { ChangedFile, PRContext } from './types/index.js';

/** Options for local git diff helpers. */
export interface LocalDiffOptions {
  /** Working directory the git commands run in. Defaults to process.cwd(). */
  cwd?: string;
}

/** A parsed per-file block of a unified git diff. */
interface ParsedDiffBlock {
  /** Repo-root-relative new file path. */
  path: string;
  /** Change status inferred from the diff headers. */
  status: ChangedFile['status'];
  /** Raw unified diff block content (including the `diff --git` header line). */
  patch: string;
}

/** Unified diff file header: `diff --git a/<old> b/<new>`. */
const DIFF_FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/;
/** Marker for brand-new files. */
const NEW_FILE_MODE = /^new file mode/;
/** Marker for deleted files. */
const DELETED_FILE_MODE = /^deleted file mode/;
/** Marker for the original path of a renamed file. */
const RENAME_FROM = /^rename from (.*)$/;
/** Marker for the final path of a renamed file. */
const RENAME_TO = /^rename to (.*)$/;
/** Prefix of the new-file path line in a unified diff. */
const NEW_PATH_LINE = /^\+\+\+ (.*)$/;

/**
 * Extract the child process stderr from an execFileSync failure.
 * @param err - Error thrown by execFileSync.
 * @returns The trimmed stderr text, or an empty string when unavailable.
 */
function gitErrorStderr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr: unknown }).stderr;
    if (typeof stderr === 'string') return stderr.trim();
    if (Buffer.isBuffer(stderr)) return stderr.toString('utf-8').trim();
  }
  return '';
}

/**
 * Run a git command synchronously and return its raw stdout.
 * @param args - Git arguments (excluding the leading `git`).
 * @param cwd - Optional working directory to run in.
 * @returns Raw stdout of the command.
 * @throws An Error with git's stderr message when git is unavailable or fails.
 */
export function runGitCommand(args: string[], cwd?: string): string {
  try {
    return cp.execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
  } catch (err) {
    const stderr = gitErrorStderr(err);
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
}

/**
 * Strip git's C-style quoting from a path. Git quotes paths containing special
 * characters (spaces, quotes, tabs, non-ASCII) with double quotes; JSON parsing
 * handles the common escape sequences git emits.
 * @param path - Raw path from git output.
 * @returns The unquoted path.
 */
export function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Parse the `--numstat` output of a git diff into a map of new file path →
 * addition/deletion counts. Handles `-` placeholders for binary files and the
 * `old => new` path format used for renames.
 * @param numstat - Raw `git diff --numstat` output.
 * @returns Map of path to addition/deletion counts.
 */
export function parseGitNumstat(
  numstat: string,
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parseNumField(parts[0]);
    const deletions = parseNumField(parts[1]);
    let path = unquoteGitPath(parts.slice(2).join('\t'));
    // Renames are reported as "old path => new path" in numstat.
    const arrowIndex = path.lastIndexOf(' => ');
    if (arrowIndex !== -1) {
      path = path.slice(arrowIndex + 4);
    }
    result.set(path, { additions, deletions });
  }
  return result;
}

/**
 * Parse a numeric additions/deletions field from numstat output.
 * Binary files use `-`, which has no line counts and maps to 0.
 * @param value - Raw field value.
 * @returns The parsed non-negative count.
 */
function parseNumField(value: string): number {
  if (value === '-' || value === '') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Split a raw `git diff` (patch) into per-file blocks, inferring each file's
 * path and change status from the diff headers.
 * @param patch - Raw `git diff` output.
 * @returns Parsed per-file diff blocks.
 */
export function parseGitDiffBlocks(patch: string): ParsedDiffBlock[] {
  const blocks: ParsedDiffBlock[] = [];
  const lines = patch.split('\n');
  let current: string[] | null = null;
  let currentPath = '';
  let currentStatus: ChangedFile['status'] = 'modified';

  const flush = (): void => {
    if (current !== null) {
      blocks.push({ path: currentPath, status: currentStatus, patch: current.join('\n') });
    }
  };

  for (const line of lines) {
    const headerMatch = DIFF_FILE_HEADER.exec(line);
    if (headerMatch) {
      flush();
      current = [line];
      currentPath = unquoteGitPath(headerMatch[2]);
      currentStatus = 'modified';
      continue;
    }
    if (current === null) continue;
    current.push(line);
    if (NEW_FILE_MODE.test(line)) {
      currentStatus = 'added';
      continue;
    }
    if (DELETED_FILE_MODE.test(line)) {
      currentStatus = 'removed';
      continue;
    }
    const renameTo = RENAME_TO.exec(line);
    if (renameTo) {
      currentStatus = 'renamed';
      currentPath = unquoteGitPath(renameTo[1]);
      continue;
    }
    if (RENAME_FROM.test(line)) {
      currentStatus = 'renamed';
      continue;
    }
    // The `+++ b/<path>` line is the authoritative new-file path (its absence
    // for removed files is handled by the deleted-file-mode marker above).
    const newPathMatch = NEW_PATH_LINE.exec(line);
    if (newPathMatch && currentStatus !== 'renamed') {
      const newPath = unquoteGitPath(newPathMatch[1]);
      if (newPath !== '/dev/null' && newPath.length > 0) {
        currentPath = newPath.startsWith('b/') ? newPath.slice(2) : newPath;
      }
    }
  }
  flush();
  return blocks;
}

/**
 * Parse a raw `git diff` (patch) together with its `--numstat` output into
 * {@link ChangedFile} entries suitable for a {@link PRContext}. Patch content is
 * preserved verbatim per file so the review engine can render the diff.
 * @param patch - Raw `git diff` output.
 * @param numstat - Raw `git diff --numstat` output.
 * @returns Parsed changed files.
 */
export function parseGitDiff(patch: string, numstat: string): ChangedFile[] {
  const blocks = parseGitDiffBlocks(patch);
  const numstatMap = parseGitNumstat(numstat);
  return blocks.map((block) => {
    const stats = numstatMap.get(block.path);
    return {
      path: block.path,
      status: block.status,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      patch: block.patch,
    };
  });
}

/**
 * Check whether `cwd` is inside an initialized git work tree.
 * @param cwd - Optional working directory.
 * @returns True when git reports the directory is inside a work tree.
 */
export function isInsideGitWorkTree(cwd?: string): boolean {
  try {
    return runGitCommand(['rev-parse', '--is-inside-work-tree'], cwd).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Read a git config value, returning an empty string when unset.
 * @param key - Git config key (e.g. "user.name").
 * @param cwd - Optional working directory.
 * @returns The config value, or '' when git is unavailable or the key is unset.
 */
function gitConfigValue(key: string, cwd?: string): string {
  try {
    return runGitCommand(['config', key], cwd).trim();
  } catch {
    return '';
  }
}

/**
 * Resolve the current HEAD SHA.
 * @param cwd - Optional working directory.
 * @returns The full HEAD SHA, or 'HEAD' when git is unavailable.
 */
function gitHeadSha(cwd?: string): string {
  try {
    return runGitCommand(['rev-parse', 'HEAD'], cwd).trim();
  } catch {
    return 'HEAD';
  }
}

/**
 * Resolve the current branch name.
 * @param cwd - Optional working directory.
 * @returns The short branch name, or 'HEAD' when detached/unavailable.
 */
function gitCurrentBranch(cwd?: string): string {
  try {
    return runGitCommand(['symbolic-ref', '--short', 'HEAD'], cwd).trim();
  } catch {
    return 'HEAD';
  }
}

/**
 * Compute the merge-base of two refs.
 * @param refA - First ref.
 * @param refB - Second ref.
 * @param cwd - Optional working directory.
 * @returns The merge-base SHA, or '' when the refs have no common ancestor.
 */
function gitMergeBase(refA: string, refB: string, cwd?: string): string {
  try {
    return runGitCommand(['merge-base', refA, refB], cwd).trim();
  } catch {
    return '';
  }
}

/**
 * Build a PR-like context for a local diff.
 * @param changedFiles - Changed files parsed from the local diff.
 * @param baseRef - What the diff is compared against (e.g. "staged" or a branch name).
 * @param baseSha - Optional base SHA for blame scope resolution.
 * @param cwd - Optional working directory.
 * @returns A PRContext describing the local change set.
 */
function buildLocalPRContext(
  changedFiles: ChangedFile[],
  baseRef: string,
  baseSha: string | undefined,
  cwd?: string,
): PRContext {
  const author = gitConfigValue('user.name', cwd) || 'local-user';
  const headSha = gitHeadSha(cwd);
  const headRef = gitCurrentBranch(cwd);
  return {
    number: 0,
    title: `Local review (${baseRef} → ${headRef})`,
    body: 'Local review of uncommitted changes via the opencode-reviewer CLI.',
    headRef,
    headSha,
    baseRef,
    baseSha,
    author,
    labels: [],
    changedFiles,
  };
}

/**
 * Build a PRContext from the staged (index) changes.
 * Runs `git diff --cached` locally; no GitHub API access is required.
 * @param options - Optional working directory.
 * @returns A PRContext describing the staged changes.
 */
export function buildPRContextFromStagedDiff(options: LocalDiffOptions = {}): PRContext {
  const cwd = options.cwd;
  const patch = runGitCommand(['diff', '--cached'], cwd);
  const numstat = runGitCommand(['diff', '--cached', '--numstat'], cwd);
  const changedFiles = parseGitDiff(patch, numstat);
  // Uncommitted index changes have no committed SHA to blame, so point baseSha
  // at HEAD to make the engine's PR-commit scope resolve to an empty set and
  // skip blame cleanly (a git error would otherwise surface as a warning).
  const headSha = gitHeadSha(cwd);
  return buildLocalPRContext(changedFiles, 'staged', headSha, cwd);
}

/**
 * Build a PRContext from the diff between a branch and HEAD.
 * Runs `git diff <branch>...HEAD` locally; no GitHub API access is required.
 * @param branch - Branch (or ref) to diff against.
 * @param options - Optional working directory.
 * @returns A PRContext describing the changes unique to HEAD relative to the branch.
 */
export function buildPRContextFromBranchDiff(
  branch: string,
  options: LocalDiffOptions = {},
): PRContext {
  const cwd = options.cwd;
  const range = `${branch}...HEAD`;
  const patch = runGitCommand(['diff', range], cwd);
  const numstat = runGitCommand(['diff', range, '--numstat'], cwd);
  const changedFiles = parseGitDiff(patch, numstat);
  const headSha = gitHeadSha(cwd);
  const baseSha = gitMergeBase(branch, headSha, cwd);
  return buildLocalPRContext(changedFiles, branch, baseSha || undefined, cwd);
}
