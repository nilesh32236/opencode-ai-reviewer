/**
 * L-054 repo-level guard — CI entry point.
 *
 * Gathers review evidence for every open PR via `gh api`, hands it to the pure
 * {@link evaluateVerdictFreshness} in lib, and exits non-zero when any PR
 * carries no verdict or a verdict older than its head commit.
 *
 * The decision logic lives in lib/src/utils/verdict-freshness.ts and is unit
 * tested there against the duoport #135 fixture. This file is only I/O.
 *
 * Usage:
 *   tsx .github/scripts/check-verdict-freshness.ts [--repo owner/name] [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  type VerdictFreshnessReport,
  type VerdictPull,
  evaluateVerdictFreshness,
  formatVerdictFreshnessReport,
  sanitizeErrorMessage,
} from '../../lib/src/index.js';

/** Options parsed from argv. */
interface CliOptions {
  repo: string;
  json: boolean;
}

/** Shape of `.github/verdict-freshness-baseline.json`. */
interface BaselineFile {
  prs?: unknown;
}

function parseArgs(argv: string[]): CliOptions {
  let repo = process.env.GITHUB_REPOSITORY ?? '';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) repo = argv[i + 1];
    if (argv[i] === '--json') json = true;
  }
  return { repo, json };
}

/**
 * Read the hand-maintained baseline of known-bad PRs.
 *
 * Read-only by design: there is no `--update-baseline` flag, because a
 * baseline that blesses itself is a guard that stops firing. Missing or
 * malformed baseline degrades to an empty baseline (guard fully armed), never
 * to a crash or a silent pass.
 */
function readBaseline(): number[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '..', 'verdict-freshness-baseline.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as BaselineFile;
    if (!Array.isArray(parsed.prs)) return [];
    return parsed.prs.filter((n): n is number => Number.isFinite(n));
  } catch {
    return [];
  }
}

/** Run `gh api` and parse the JSON response. */
function ghApi<T>(args: string[]): T {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as T;
}

/**
 * Count AI review check runs that COMPLETED successfully on a PR's head.
 *
 * Matches the `AI Code Review` check by name rather than counting every
 * workflow on the SHA: "3 workflows ran" is not evidence that a review was
 * owed, and a loose count would make the guard report a lost verdict on PRs
 * where the review job never ran at all.
 */
function completedReviewRuns(repo: string, headSha: string): number {
  interface CheckRun {
    name?: string;
    status?: string;
    conclusion?: string;
  }
  const jobName = process.env.REVIEW_CHECK_NAME ?? 'AI Code Review';
  try {
    const res = ghApi<CheckRun[] | { check_runs?: CheckRun[] }>([
      'api',
      '--paginate',
      `repos/${repo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
    ]);
    const runs = Array.isArray(res) ? res : (res?.check_runs ?? []);
    return runs.filter(
      (r) =>
        r?.name === jobName &&
        r?.status === 'completed' &&
        r?.conclusion !== 'skipped' &&
        r?.conclusion !== 'cancelled',
    ).length;
  } catch {
    // Evidence we could not gather is not evidence of a fault; the pure
    // evaluator still judges on the review list alone.
    return 0;
  }
}

/**
 * Committer date of a commit, used as the "head commit is newer than the
 * verdict" reference.
 *
 * This must be the real commit date, NOT the PR's `updated_at`. `updated_at`
 * moves on any touch — a comment, a label, a review — so using it reports
 * healthy PRs as stale. Verified against live data on 2026-10-02: #845's
 * `updated_at` is 3h after its head commit (a later comment), which made a
 * verdict posted 29 minutes after the commit look 164 minutes stale.
 */
function commitDate(repo: string, sha: string): string | null {
  try {
    const res = ghApi<{ commit?: { committer?: { date?: string } } }>([
      'api',
      `repos/${repo}/commits/${encodeURIComponent(sha)}`,
    ]);
    return res?.commit?.committer?.date ?? null;
  } catch {
    // null makes the evaluator fail closed (stale), which is the safe
    // direction for a freshness comparison.
    return null;
  }
}

/** Collect PR + review evidence for every open PR in the repository. */
export function collectPulls(repo: string): VerdictPull[] {
  interface RawPull {
    number: number;
    title?: string;
    html_url?: string;
    draft?: boolean;
    head?: { ref?: string; sha?: string };
    updated_at?: string;
  }
  interface RawReview {
    user?: { login?: string | null } | null;
    submitted_at?: string | null;
    state?: string;
    commit_id?: string | null;
    body?: string | null;
  }
  /** One entry of `gh pr view --json files` — the PR's changed-file set. */
  interface RawFile {
    filename?: string;
  }

  /**
   * The PR's changed-file set, used by the `mismatched-verdict` check.
   *
   * `commit_id` proves a verdict read a commit; it does not prove the verdict
   * describes THIS pull request. Without the diff there is no second half of
   * that identity, and the check stays silent rather than guessing.
   *
   * A failed fetch is recorded as `null`, NOT as `[]`: an empty array would
   * read as "this PR changes nothing", which would make every anchored verdict
   * in the repo a mismatch.
   */
  function fetchChangedFiles(repo: string, prNumber: number): string[] | null {
    try {
      // `--paginate` is load-bearing, not tidiness. Without it the fetch returns
      // only the first 100 files, so on a PR touching more than that an anchor
      // pointing at file 101+ looks FOREIGN and the guard reports a mismatch
      // that is not there. A truncated diff is the one input that turns this
      // check into a false-positive generator, which is worse than not having it.
      const res = ghApi<RawFile[]>([
        'api',
        '--paginate',
        `repos/${repo}/pulls/${prNumber}/files?per_page=100`,
      ]);
      if (!Array.isArray(res)) return null;
      // `gh api .../pulls/N/files` returns `filename`, not `path`. Reading the
      // wrong field yields `undefined` for every entry, the filter drops them
      // all, and the result is an EMPTY array — which reads as "this PR changes
      // nothing" and would make every anchored verdict a mismatch. Verified
      // against the live API: the keys are additions, blob_url, changes,
      // contents_url, deletions, filename, patch, raw_url, sha, status.
      return res
        .map((f) => f?.filename)
        .filter((p): p is string => typeof p === 'string' && p !== '');
    } catch {
      // Evidence we could not gather is not evidence of a fault; the evaluator
      // treats null as "could not look" and skips the mismatch check.
      return null;
    }
  }

  const raw = ghApi<RawPull[]>([
    'api',
    '--paginate',
    `repos/${repo}/pulls?state=open&per_page=100`,
  ]);

  return raw.map((pr) => {
    const headSha = pr.head?.sha ?? '';
    let reviews: RawReview[] = [];
    // A failed fetch is recorded, NOT flattened into `reviews = []`.
    // "We could not look" and "there is nothing there" are opposite facts, and
    // reporting a network blip as a lost verdict is a lie that teaches people
    // to ignore this check.
    let reviewsFetchError: string | undefined;
    let changedFiles: string[] | null;
    try {
      reviews = ghApi<RawReview[]>([
        'api',
        '--paginate',
        `repos/${repo}/pulls/${pr.number}/reviews?per_page=100`,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Redact credentials with the canonical helper instead of an inlined
      // regex. This script already imports from `lib/src/index.js` above, and
      // that import resolves under `tsx` in CI (verified against the workflow's
      // own invocation), so there is no reason to carry a second, weaker copy
      // of the pattern set here. The previous inlined subset missed
      // `github_pat_` — the fine-grained PAT form GitHub issues by default —
      // plus every non-GitHub credential family.
      reviewsFetchError = sanitizeErrorMessage(msg);
    }
    // Fetched separately from the reviews: a failure here must not be recorded
    // as a reviews failure, and a reviews failure must not discard the diff.
    //
    // The helper is named `fetchChangedFiles`, not `changedFiles`, because a
    // local of the same name shadows it in this scope and turns this line into
    // a self-assignment of an uninitialised variable. That compiled cleanly and
    // threw at runtime, the catch below swallowed it, and the mismatch check
    // became dead code in CI while its unit tests still passed.
    try {
      changedFiles = fetchChangedFiles(repo, pr.number);
    } catch {
      changedFiles = null;
    }
    return {
      number: pr.number,
      title: pr.title,
      html_url: pr.html_url,
      draft: pr.draft,
      head_ref: pr.head?.ref,
      head_sha: headSha,
      // The real head-commit date. `updated_at` is deliberately NOT used: it
      // moves on any PR touch, so a comment posted after the review makes a
      // perfectly fresh verdict look stale.
      head_date: headSha ? commitDate(repo, headSha) : null,
      reviews,
      ...(reviewsFetchError !== undefined ? { reviewsFetchError } : {}),
      completedReviewRuns: headSha ? completedReviewRuns(repo, headSha) : 0,
      // The diff is the second half of a verdict's identity. Absent (null) the
      // mismatch check is skipped, never guessed.
      ...(changedFiles !== null ? { changedFiles } : {}),
    } satisfies VerdictPull;
  });
}

function main(): number {
  const { repo, json } = parseArgs(process.argv.slice(2));
  if (!repo) {
    process.stderr.write(
      'ERROR: no repository. Pass --repo owner/name or set GITHUB_REPOSITORY.\n',
    );
    return 2;
  }

  const pulls = collectPulls(repo);
  const baseline = readBaseline();
  const report = evaluateVerdictFreshness(pulls, { baseline });
  const markdown = formatVerdictFreshnessReport(report);

  if (json) {
    process.stdout.write(`${JSON.stringify({ baseline, ...report }, null, 2)}\n`);
  } else {
    process.stdout.write(`${markdown}\n`);
    if (baseline.length > 0) {
      process.stdout.write(
        `\n_Baseline: ${baseline.length} known L-054 violation(s) tolerated — #${baseline.join(', #')} (see .github/verdict-freshness-baseline.json)_\n`,
      );
    }
  }

  return exitCodeFor(report);
}

/**
 * Map a report to a process exit code.
 *
 * The codes are distinct on purpose, so a reader (human or automation) can
 * tell "a verdict is genuinely missing" from "we could not check":
 *
 * - `0` every PR judged, none violating
 * - `1` at least one verdict is genuinely LOST or STALE
 * - `2` usage error (handled by the caller)
 * - `3` evidence UNREADABLE — inconclusive, and explicitly NOT a lost verdict
 *
 * Exported and pure so this is unit-testable; an exit code is the machine's
 * only view of the guard, and it must not quietly collapse case 3 into case 1.
 * @param report - The evaluated report.
 * @returns The process exit code.
 * @since NEXT
 */
export function exitCodeFor(report: VerdictFreshnessReport): number {
  if (report.violations.length > 0) {
    process.stderr.write(
      `\nERROR: ${report.violations.length} open PR(s) carry no usable verdict.\n` +
        `A green review job is not evidence that a verdict reached the PR (L-054).\n` +
        `Re-run the review, or check whether the post was rejected.\n`,
    );
    return 1;
  }
  const indeterminate = report.indeterminate ?? [];
  if (indeterminate.length > 0) {
    process.stderr.write(
      `\nINCONCLUSIVE: ${indeterminate.length} PR(s) could not be checked (#${indeterminate
        .map((i) => i.number)
        .join(', #')}).\n` +
        `This is NOT a claim that any verdict was lost — the reviews could not be read.\n` +
        `Usually a transient API or network failure; re-run the job. Failing closed\n` +
        `because the guard cannot certify what it did not read.\n`,
    );
    return 3;
  }
  return 0;
}

// Only run when executed directly, so the module stays importable by tests.
if (process.argv[1]?.endsWith('check-verdict-freshness.ts')) {
  process.exit(main());
}
