import * as cp from 'node:child_process';
import * as core from '@actions/core';
import type { BlameInfo } from '../types/index.js';

/** A contiguous 1-indexed (inclusive) range of new-file line numbers to blame. */
export interface BlameRange {
  /** First line number to blame. */
  start: number;
  /** Last line number to blame (inclusive). */
  end: number;
}

/** Options for {@link getGitBlame}. */
export interface GetGitBlameOptions {
  /** Working directory the `git blame` command runs in. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Set of commit SHAs that belong to the current PR. Lines last modified by one
   * of these commits are tagged `isInPRDiff: true`. When omitted, all blamed
   * lines are conservatively treated as part of the PR.
   */
  prCommits?: Set<string>;
  /**
   * Commit SHA to blame at. When provided, blame resolves line attribution
   * against the file content at that commit instead of the working tree, so the
   * reported line numbers stay aligned with the platform patch (base..head) even
   * when the working tree has been edited (e.g. mid autofix loop).
   */
  headSha?: string;
  /**
   * Per-file cap on the number of blamed lines before blame is skipped for the
   * file. Defaults to {@link MAX_BLAME_LINES_PER_FILE}.
   */
  maxLinesPerFile?: number;
}

/** Raw per-line attribution parsed from `git blame --line-porcelain` output. */
export interface BlameAttribution {
  /** Full commit SHA of the last modification (all zeros for uncommitted lines). */
  commitSha: string;
  /** Author of the last modification. */
  author: string;
  /** Date (YYYY-MM-DD) of the last modification. */
  date: string;
}

/**
 * Default maximum number of lines blamed per file before blame is skipped.
 * Matches the default `reviewBudget.splitThreshold`; callers that configure a
 * different threshold should pass it explicitly via `maxLinesPerFile`.
 */
export const MAX_BLAME_LINES_PER_FILE = 1000;

/** The all-zero SHA `git blame` reports for lines modified in the working tree. */
export const UNCOMMITTED_SHA = '0'.repeat(40);

/** Unified diff hunk header regex: extracts the new-file start line and line count. */
const HUNK_REGEX = /^@@\s+-[0-9,]+\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/;

/** `git blame --line-porcelain` entry header: `<sha> <orig> <final> [<num>]`. */
const LINE_HEADER_REGEX = /^[0-9a-f]{40}\s+\d+\s+(\d+)(?:\s+\d+)?\s*$/;

/**
 * Parse the new-file line ranges covered by a unified diff patch. Blame is only
 * ever run over these hunk ranges (never the whole file) so cost is bounded by
 * the diff size. Hunks with no new-file lines (pure deletions) are skipped —
 * there is nothing to blame in the new file and `git blame -L` rejects them.
 *
 * @param patch - Unified diff patch content for a changed file.
 * @returns Array of 1-indexed inclusive new-file line ranges per hunk.
 */
export function parsePatchHunks(patch: string): BlameRange[] {
  const ranges: BlameRange[] = [];
  if (!patch) return ranges;
  for (const line of patch.split('\n')) {
    const match = HUNK_REGEX.exec(line);
    if (match) {
      const start = Number.parseInt(match[1], 10);
      const count = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
      if (count < 1) continue;
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
}

/**
 * Compute the set of new-file line numbers actually present in a (possibly
 * truncated) unified diff patch. Deletion-only lines and hunk bodies cut off by
 * truncation are naturally excluded because only context (` `) and addition
 * (`+`) lines advance the new-file line counter.
 *
 * @param patch - Unified diff patch content (possibly truncated).
 * @returns Set of new-file line numbers visible in the patch.
 */
export function parsePatchVisibleLines(patch: string): Set<number> {
  const visible = new Set<number>();
  if (!patch) return visible;
  let inHunk = false;
  let lineNum = 0;
  for (const line of patch.split('\n')) {
    const match = HUNK_REGEX.exec(line);
    if (match) {
      inHunk = true;
      lineNum = Number.parseInt(match[1], 10);
      continue;
    }
    if (!inHunk) continue;
    const prefix = line[0];
    if (prefix === '+' || prefix === ' ') {
      visible.add(lineNum);
      lineNum++;
    }
    // `-` deletions consume no new-file line.
  }
  return visible;
}

/**
 * Filter a blame map down to the line numbers visible in the given patch, so
 * annotations never cite lines hidden by diff truncation.
 * @param blame - Line number → blame info for one file.
 * @param patch - The (possibly truncated) patch the annotations are rendered for.
 * @returns The filtered blame map and the number of dropped entries.
 */
export function filterBlameToPatch(
  blame: Map<number, BlameInfo>,
  patch: string,
): { blame: Map<number, BlameInfo>; dropped: number } {
  if (blame.size === 0) return { blame, dropped: 0 };
  const visible = parsePatchVisibleLines(patch);
  const kept = new Map<number, BlameInfo>();
  let dropped = 0;
  for (const [line, info] of blame) {
    if (visible.has(line)) {
      kept.set(line, info);
    } else {
      dropped++;
    }
  }
  return { blame: kept, dropped };
}

/**
 * Parse `git blame --line-porcelain` output into per-line attribution.
 *
 * With `--line-porcelain` every line has its own entry: a header line
 * (`<sha> <orig> <final> [<count>]`), a set of metadata key/value lines, and a
 * tab-prefixed content line.
 *
 * @param output - Raw stdout from `git blame --line-porcelain`.
 * @returns A map of final line number to its attribution.
 */
export function parseBlamePorcelain(output: string): Map<number, BlameAttribution> {
  const result = new Map<number, BlameAttribution>();
  const lines = output.split('\n');
  let i = 0;
  while (i < lines.length) {
    const header = LINE_HEADER_REGEX.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }
    const commitSha = lines[i].slice(0, 40);
    const finalLine = Number.parseInt(header[1], 10);
    let author = '';
    let date = '';
    i++;
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const meta = lines[i];
      if (meta.startsWith('author ')) {
        author = meta.slice('author '.length).trim();
      } else if (meta.startsWith('author-time ')) {
        const ts = Number.parseInt(meta.slice('author-time '.length).trim(), 10);
        if (Number.isFinite(ts) && ts > 0) {
          date = new Date(ts * 1000).toISOString().slice(0, 10);
        }
      }
      i++;
    }
    // Skip the tab-prefixed content line that ends the entry.
    if (i < lines.length) i++;
    result.set(finalLine, { commitSha, author, date });
  }
  return result;
}

/**
 * Run `git blame` asynchronously via `execFile`, so the long-running Probot App
 * event loop is never blocked (mirrors the engine's own async `execGit`
 * design). A hard timeout bounds hung git processes.
 * @param args - Git arguments (excluding the leading `git`).
 * @param cwd - Directory the command runs in.
 * @returns The raw stdout (untrimmed, so line numbers are preserved).
 */
function execGitBlame(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof cp.execFile !== 'function') {
      reject(new Error('execFile is not available'));
      return;
    }
    cp.execFile(
      'git',
      args,
      { cwd, encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/**
 * Fetch git blame attribution for the given line ranges of a file.
 *
 * Runs `git blame -L <start>,<end> --line-porcelain <file>` over each provided
 * range and annotates every line with whether it was introduced by the current
 * PR (via commit membership). When {@link GetGitBlameOptions.headSha} is set,
 * blame runs against that commit rather than the working tree so line numbers
 * stay aligned with the reviewed patch. Best-effort enrichment: rejects when
 * git is unavailable or the command fails so callers can degrade gracefully.
 *
 * @param filePath - Repo-root-relative path of the file to blame.
 * @param ranges - New-file line ranges to blame (typically diff hunk ranges).
 * @param options - Cwd, PR commit set, optional head commit and line cap.
 * @returns A map of line number to {@link BlameInfo}.
 */
export async function getGitBlame(
  filePath: string,
  ranges: BlameRange[],
  options: GetGitBlameOptions = {},
): Promise<Map<number, BlameInfo>> {
  const cwd = options.cwd || process.cwd();
  const prCommits = options.prCommits;
  const maxLines = options.maxLinesPerFile ?? MAX_BLAME_LINES_PER_FILE;

  const totalLines = ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start + 1), 0);
  if (totalLines === 0) return new Map();
  if (totalLines > maxLines) {
    core.warning(
      `Skipping git blame for ${filePath}: ${totalLines} lines exceeds the ` +
        `${maxLines}-line per-file cap`,
    );
    return new Map();
  }

  const args = ['blame', '--line-porcelain'];
  if (options.headSha) args.push(options.headSha);
  for (const range of ranges) {
    args.push('-L', `${range.start},${range.end}`);
  }
  args.push('--', filePath);

  const stdout = await execGitBlame(args, cwd);
  const parsed = parseBlamePorcelain(stdout);

  const result = new Map<number, BlameInfo>();
  for (const [lineNumber, attribution] of parsed) {
    const isUncommitted = attribution.commitSha === UNCOMMITTED_SHA;
    // Conservative default: without a PR commit set, treat every line as part
    // of the PR so pre-existing issues are never silently deprioritized.
    const isInPRDiff = isUncommitted || (prCommits ? prCommits.has(attribution.commitSha) : true);
    result.set(lineNumber, { ...attribution, isInPRDiff });
  }
  return result;
}
