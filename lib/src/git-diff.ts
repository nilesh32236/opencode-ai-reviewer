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

/** Prefix of the unified diff file header line: `diff --git a/<old> b/<new>`. */
const DIFF_FILE_HEADER_PREFIX = 'diff --git ';
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
/** Hunk header that begins a unified diff hunk body. */
const HUNK_HEADER = /^@@ /;

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
 *
 * Commands run with `core.quotePath=false` so non-ASCII paths are emitted as
 * raw bytes instead of C-quoted octal escapes (which the diff parser cannot
 * round-trip). A generous `maxBuffer` and a hard timeout keep large local diffs
 * usable and prevent a hung git invocation from hanging the CLI.
 * @param args - Git arguments (excluding the leading `git`).
 * @param cwd - Optional working directory to run in.
 * @returns Raw stdout of the command.
 * @throws An Error with git's stderr message when git is unavailable or fails.
 */
export function runGitCommand(args: string[], cwd?: string): string {
  try {
    return cp.execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // execFileSync defaults maxBuffer to 1 MB; real branch diffs routinely
      // exceed that (lockfiles, generated files, big refactors).
      maxBuffer: 100 * 1024 * 1024,
      // Bound each git call so a hung invocation (e.g. slow worktree) can't
      // hang the CLI indefinitely.
      timeout: 60_000,
      ...(cwd ? { cwd } : {}),
    });
  } catch (err) {
    const stderr = gitErrorStderr(err);
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
}

/**
 * Decode git's C-style octal escapes (`\NNN`) into their raw byte values and
 * reassemble them as UTF-8. Used as a fallback when a path is quoted but its
 * escapes are not valid JSON (JSON does not support octal escapes).
 * @param value - String possibly containing `\NNN` sequences.
 * @returns The decoded string.
 */
function decodeGitOctalEscapes(value: string): string {
  if (!value.includes('\\')) return value;
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && i + 3 < value.length && /^[0-7]{3}$/.test(value.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(value.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      // Non-escape characters are already decoded text; re-encode them so the
      // final byte buffer round-trips through UTF-8 without corruption.
      for (const byte of Buffer.from(ch, 'utf-8')) {
        bytes.push(byte);
      }
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Strip git's C-style quoting from a path. Git quotes paths containing special
 * characters (spaces, quotes, tabs, non-ASCII) with double quotes; JSON parsing
 * handles the common escape sequences git emits, with an octal-escape fallback
 * for the escapes JSON does not support.
 * @param path - Raw path from git output.
 * @returns The unquoted path.
 */
export function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return decodeGitOctalEscapes(trimmed.slice(1, -1));
    }
  }
  return trimmed;
}

/**
 * Split the remainder of a `diff --git` header line into its two path tokens.
 * Each token is either bare (`a/foo`, `b/foo`) or C-quoted
 * (`"a/foo bar"`, `"b/foo bar"`) when the path contains special characters.
 * @param rest - Header content after the `diff --git ` prefix.
 * @returns The two tokens, or null when the header shape is unrecognized.
 */
function splitDiffHeaderTokens(rest: string): string[] | null {
  const tokens: string[] = [];
  let index = 0;
  while (index < rest.length) {
    while (index < rest.length && rest[index] === ' ') index += 1;
    if (index >= rest.length) break;
    if (rest[index] === '"') {
      // Scan for the closing quote, skipping over backslash escapes git emits
      // for embedded quotes (`\"`) and other special characters.
      let close = index + 1;
      while (close < rest.length) {
        if (rest[close] === '\\') {
          close += 2;
          continue;
        }
        if (rest[close] === '"') break;
        close += 1;
      }
      if (close >= rest.length) return null;
      tokens.push(rest.slice(index, close + 1));
      index = close + 1;
    } else {
      const space = rest.indexOf(' ', index);
      if (space === -1) {
        tokens.push(rest.slice(index));
        break;
      }
      tokens.push(rest.slice(index, space));
      index = space;
    }
  }
  return tokens.length === 2 ? tokens : null;
}

/**
 * Strip the leading `a/` or `b/` prefix from a header token, preserving
 * C-quoting so {@link unquoteGitPath} can decode embedded escapes.
 * @param token - A raw header token (possibly C-quoted).
 * @returns The path with its prefix removed, or null when the prefix is absent.
 */
function stripPathPrefix(token: string): string | null {
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    const inner = token.slice(1, -1);
    if (!(inner.startsWith('a/') || inner.startsWith('b/'))) return null;
    return `"${inner.slice(2)}"`;
  }
  if (token.startsWith('a/') || token.startsWith('b/')) return token.slice(2);
  return null;
}

/**
 * Match a unified diff file header (`diff --git a/<old> b/<new>`) using direct
 * string searches instead of a regex. The historical
 * `/^diff --git a\/(.*) b\/(.*)$/` pattern could backtrack quadratically on
 * crafted input. Git emits two header shapes:
 *  - Unquoted `diff --git a/<old> b/<new>` for ordinary paths (including paths
 *    that merely contain spaces), where the boundary is the last ` b/`.
 *  - C-quoted `diff --git "a/<old>" "b/<new>"` when a path contains special
 *    characters such as quotes or tabs.
 * @param line - A raw diff line.
 * @returns `[oldPath, newPath]` without the `a/`/`b/` prefixes, or null.
 */
function matchDiffFileHeader(line: string): [string, string] | null {
  if (!line.startsWith(DIFF_FILE_HEADER_PREFIX)) return null;

  // C-quoted form: paths with special characters are wrapped in double quotes.
  if (line.startsWith(`${DIFF_FILE_HEADER_PREFIX}"`)) {
    const tokens = splitDiffHeaderTokens(line.slice(DIFF_FILE_HEADER_PREFIX.length));
    if (tokens === null) return null;
    const oldPath = stripPathPrefix(tokens[0]);
    const newPath = stripPathPrefix(tokens[1]);
    if (oldPath === null || newPath === null) return null;
    return [oldPath, newPath];
  }

  // Unquoted form. Paths may themselves contain spaces, so the boundary is the
  // LAST ` b/` occurrence (mirrors the `lastIndexOf(' => ')` approach used for
  // numstat renames, and tolerates a literal ` b/` inside a path).
  if (!line.startsWith(`${DIFF_FILE_HEADER_PREFIX}a/`)) return null;
  const rest = line.slice(DIFF_FILE_HEADER_PREFIX.length + 2);
  const sep = rest.lastIndexOf(' b/');
  if (sep === -1) return null;
  return [rest.slice(0, sep), rest.slice(sep + 3)];
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
    const rawPath = parts.slice(2).join('\t');
    // Renames are reported as "old path => new path" in numstat. Split on the
    // top-level ` => ` and decode only the new-path token: when the rename's
    // paths contain special characters git quotes each side independently
    // (`"old path" => "new path"`), so unquoting the full string first would
    // leave a dangling quote that never matches the block path.
    const arrowIndex = rawPath.lastIndexOf(' => ');
    const path = unquoteGitPath(arrowIndex === -1 ? rawPath : rawPath.slice(arrowIndex + 4));
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
  let inHunk = false;

  const flush = (): void => {
    if (current !== null) {
      blocks.push({ path: currentPath, status: currentStatus, patch: current.join('\n') });
    }
  };

  for (const line of lines) {
    const headerMatch = matchDiffFileHeader(line);
    if (headerMatch) {
      flush();
      current = [line];
      currentPath = unquoteGitPath(headerMatch[1]);
      currentStatus = 'modified';
      inHunk = false;
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
    if (HUNK_HEADER.test(line)) {
      inHunk = true;
      continue;
    }
    // The `+++ b/<path>` header line is the authoritative new-file path (its
    // absence for removed files is handled by the deleted-file-mode marker
    // above). Only honor it before the first hunk: added content lines that
    // render as `+++ ...` must not overwrite the file's real path.
    const newPathMatch = NEW_PATH_LINE.exec(line);
    if (newPathMatch && !inHunk && currentStatus !== 'renamed') {
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
  // Reject empty and dash-prefixed refs before they reach git: git treats a
  // leading `-` as an option (e.g. `--upload-pack=...`), which could make a
  // caller-controlled ref inject arguments. git merge-base does not support an
  // end-of-options `--` separator, so rejecting here is the safe approach.
  if (branch.trim() === '' || branch.startsWith('-')) {
    throw new Error(
      `Invalid branch/ref "${branch}": branch names must not be empty or start with "-".`,
    );
  }
  const cwd = options.cwd;
  const range = `${branch}...HEAD`;
  const patch = runGitCommand(['diff', range], cwd);
  const numstat = runGitCommand(['diff', range, '--numstat'], cwd);
  const changedFiles = parseGitDiff(patch, numstat);
  const headSha = gitHeadSha(cwd);
  const baseSha = gitMergeBase(branch, headSha, cwd);
  return buildLocalPRContext(changedFiles, branch, baseSha || undefined, cwd);
}
