/**
 * L-054: repo-level guard against a verdict that never landed.
 *
 * The action fix (action/src/review.ts) makes the review job fail when it
 * cannot post its verdict. That protects the job, but not the fleet: a late
 * verdict is nearly as dangerous as a lost one, because nobody re-checks a PR
 * hours after CI goes green. This module is the second line — a check that
 * looks at what is actually ON the pull request and fails when the head commit
 * is newer than the newest bot review, or when a review run completed but no
 * review exists at all.
 *
 * Pure functions, no I/O, fail-closed on malformed input — mirroring
 * `head-ci.ts`, which this guard is the sibling of.
 */

/** A single review as returned by `GET /repos/{o}/{r}/pulls/{n}/reviews`. */
export interface ReviewRecord {
  /** Review id. */
  id?: number;
  /** Review author; only bot logins count as a delivered verdict. */
  user?: { login?: string | null } | null;
  /** ISO-8601 timestamp GitHub assigned when the review was submitted. */
  submitted_at?: string | null;
  /** Head SHA the review was anchored to, when GitHub reports it. */
  commit_id?: string | null;
  /** Review body markdown, used for signature-based identification. */
  body?: string | null;
  /**
   * Review state. A `PENDING` review was never submitted and a `DISMISSED`
   * one was withdrawn, so neither counts as a delivered verdict; absent is
   * treated as `COMMENT`, which is what the REST reviews list reports for
   * submitted reviews.
   */
  state?: string;
}

/** An open pull request plus the review evidence gathered for it. */
export interface VerdictPull {
  /** PR number. */
  number: number;
  /** PR title, for the report. */
  title?: string;
  /** Web URL, for the report. */
  html_url?: string;
  /** Head branch name; matched against `excludeBranchPrefixes`. */
  head_ref?: string;
  /** Current head commit SHA. */
  head_sha: string;
  /**
   * ISO-8601 author/commit date of the head commit. Compared against review
   * `submitted_at` to decide whether the verdict is older than the code.
   */
  head_date?: string | null;
  /** Draft PRs are not merge candidates, so they are never violations. */
  draft?: boolean;
  /** Label names currently on the PR. */
  labels?: Array<string | { name?: string }>;
  /** Reviews on the PR, newest-last or unordered — order does not matter. */
  reviews?: ReviewRecord[];
  /**
   * Files this PR actually changes, as repo-relative paths.
   *
   * This is the second half of a verdict's identity. `commit_id` proves the
   * verdict read SOME commit; it does not prove the verdict describes THIS
   * pull request. A verdict posted against the right head can still be a
   * verdict about a different PR — measured live on 2026-10-08, when #1041's
   * verdict carried the current head SHA while its body named
   * `action/src/audit.ts`, `action.yml` and `audit.integration.test.ts`, all of
   * which belong to #982, merged 30 minutes earlier. `gh pr diff 1041
   * --name-only` contains none of them, and a reader took its "no blocking
   * issue" as a statement about #1041's diff.
   *
   * Absent/empty means the caller could not supply the diff, and the mismatch
   * check is then skipped: "we could not look" is not evidence of a mismatch,
   * and inventing a file list here would be a guess dressed as a signal.
   * @since NEXT
   */
  changedFiles?: readonly string[];
  /**
   * Set when the reviews could NOT be fetched (API error, network failure,
   * auth expiry).
   *
   * This must never be flattened into an empty review list: "we could not
   * look" and "there is nothing there" are opposite facts, and conflating them
   * turns a transient network blip into a red build asserting the verdict
   * vanished — a lie about the world, and exactly how a guard teaches people
   * to ignore it.
   * @since NEXT
   */
  reviewsFetchError?: string;
  /**
   * Number of AI review runs that completed on this PR's current head. Used
   * only to distinguish "no review yet because nothing ran" from "a run
   * finished and delivered nothing".
   */
  completedReviewRuns?: number;
}

/** Why a PR failed the freshness guard. */
export type VerdictViolationKind =
  /** A verdict exists but predates the current head commit. */
  | 'stale-verdict'
  /** A review run completed but no bot review ever appeared. */
  | 'missing-verdict'
  /**
   * The verdict is fresh by commit and timestamp, but its body names files
   * that are not in this PR's diff — so it describes a DIFFERENT pull request.
   * @since NEXT
   */
  | 'mismatched-verdict';

/** One PR that fails the guard. */
export interface VerdictViolation {
  /** PR number. */
  number: number;
  /** PR title, for the report. */
  title: string;
  /** PR web URL. */
  url: string;
  /** Short head SHA. */
  headSha: string;
  /** Which rule fired. */
  kind: VerdictViolationKind;
  /** Operator-facing explanation, naming the evidence. */
  reason: string;
  /** Newest bot review time, ISO-8601, when one exists. */
  newestReviewAt?: string;
  /**
   * The commit the newest verdict actually read, when it named one. Reported
   * so an operator can see the mismatch rather than infer it.
   * @since NEXT
   */
  reviewedCommit?: string;
  /** Head commit date, ISO-8601. */
  headDate?: string;
}

/** One PR deliberately not judged, with the reason it was skipped. */
export interface VerdictSkip {
  /** PR number. */
  number: number;
  /** Why the guard stayed silent. */
  reason: string;
}

/**
 * One PR the guard could NOT judge because the evidence was unreadable.
 *
 * Indeterminate is its own outcome, deliberately separate from both
 * `violations` and `skipped`: the guard is not claiming the verdict is lost,
 * and it is not claiming it is fine either. It is saying it does not know.
 * @since NEXT
 */
export interface VerdictIndeterminate {
  /** PR number. */
  number: number;
  /** PR title. */
  title: string;
  /** PR web URL. */
  url: string;
  /** What could not be read, and why. */
  reason: string;
}

/** Outcome of {@link evaluateVerdictFreshness}. */
export interface VerdictFreshnessReport {
  /**
   * True only when every PR was judged AND no PR violates the guard.
   *
   * An indeterminate PR makes this false: the guard cannot certify what it did
   * not read. Failing closed here is what keeps an API outage from reading as
   * an all-clear.
   */
  ok: boolean;
  /** PRs that failed, sorted by number. */
  violations: VerdictViolation[];
  /** PRs that could not be judged, sorted by number. Never a lost verdict. */
  indeterminate: VerdictIndeterminate[];
  /**
   * PRs the guard deliberately did not judge. Surfaced so an exclusion can
   * never quietly hide a PR — the point of this guard is that a skipped PR is
   * a decision someone can see and argue with.
   */
  skipped: VerdictSkip[];
  /** How many PRs were judged. */
  evaluated: number;
}

/** Tuning knobs for {@link evaluateVerdictFreshness}. */
export interface VerdictFreshnessOptions {
  /**
   * Bot logins whose reviews count as a delivered verdict.
   *
   * NOT sufficient on its own. When the review job runs on a personal access
   * token (`secrets.GH_PAT`, which every fleet repo uses), GitHub attributes
   * the created review to the PAT's human owner, not to a `[bot]` account — so
   * an allowlist of bot logins alone reports every PAT-authored verdict as
   * missing. Verified against live data on 2026-10-02: all reviews in this
   * repo are authored by `nilesh32236` and every one carries the action's body
   * signature. Pair this with {@link bodySignatures}.
   */
  botLogins?: readonly string[];
  /**
   * Body markers that identify a review as this action's verdict, used when
   * the author is not a known bot login. Default `['MR Review Summary']`,
   * emitted unconditionally by `buildReviewBody`.
   *
   * This is what keeps the guard honest in both directions: an action verdict
   * posted through a PAT is recognised, while an ordinary human review ("LGTM")
   * still cannot mask a lost verdict.
   */
  bodySignatures?: readonly string[];
  /**
   * Branch prefixes that are never judged. Defaults to `['autofix/', 'improvement/']`
   * because ai-review.yml structurally refuses to review those branches (see
   * the L-054 autofix-gate finding) — flagging them would make this repo
   * permanently red and train everyone to ignore the guard.
   */
  excludeBranchPrefixes?: readonly string[];
  /**
   * How recently the head commit must be before the guard will judge it.
   * A run that is still in flight is not a lost verdict. Default 30 minutes.
   */
  headGraceMs?: number;
  /**
   * Clock skew tolerance when comparing timestamps. Default 60 seconds.
   */
  skewMs?: number;
  /** When true, a PR with no reviews at all is a violation even if no run completed. Default true. */
  requireVerdictWithoutRun?: boolean;
  /**
   * PR numbers already known to be in violation.
   *
   * A guard that turns red the moment it is switched on gets switched off.
   * When the defect has a live backlog, naming those PRs lets the guard hold
   * the line on every NEW verdict loss from its first run, instead of either
   * blocking every merge in the repo or being muted wholesale.
   *
   * A baseline entry never grants a pass: it moves the PR from `violations`
   * to `skipped` with an explicit reason, so the debt stays visible and has
   * to be deleted deliberately once the PR is reviewed or closed.
   * @since NEXT
   */
  baseline?: readonly number[];
  /**
   * Clock, in epoch ms, used for the in-flight grace window. Defaults to
   * `Date.now()`. Injectable so the tests are not at the mercy of wall-clock
   * drift: a fixture built at a fixed instant silently stops being "2 minutes
   * old" once the suite runs half an hour later.
   * @since NEXT
   */
  now?: number;
  /**
   * How many DISTINCT foreign paths a verdict body must name before it is
   * reported as describing the wrong PR. Default 2.
   *
   * The threshold is the whole defence against a crying-wolf guard. A verdict
   * that mentions one file outside the diff is usually talking about context
   * — "this duplicates the pattern in `lib/src/old.ts`" — and flagging that
   * would teach everyone to ignore the check. Two distinct files that are all
   * absent from the diff is not context; it is the shape of a verdict that was
   * rendered from another PR's findings.
   *
   * Set to 1 to be strict, or to a very large number to disable the check.
   * @since NEXT
   */
  minForeignPaths?: number;
}

/** Default bot logins recognised as the reviewer. */
export const DEFAULT_BOT_LOGINS: readonly string[] = [
  'opencode-ai-reviewer[bot]',
  'github-actions[bot]',
  'dependabot[bot]',
];

/**
 * Default body markers that identify this action's verdict.
 *
 * `buildReviewBody` emits `## MR Review Summary` in every review body, so a
 * review carrying it came from the review action — whoever the token attributed
 * it to.
 */
export const DEFAULT_BODY_SIGNATURES: readonly string[] = ['MR Review Summary'];

/** Default excluded branch prefixes — branches the review job never runs on. */
export const DEFAULT_EXCLUDED_BRANCH_PREFIXES: readonly string[] = ['autofix/', 'improvement/'];

/**
 * Default number of distinct foreign paths that makes a verdict a mismatch.
 *
 * See {@link VerdictFreshnessOptions.minForeignPaths} for why this is 2 and
 * not 1.
 */
export const DEFAULT_MIN_FOREIGN_PATHS = 2;

const DEFAULT_HEAD_GRACE_MS = 30 * 60_000;
const DEFAULT_SKEW_MS = 60_000;

/**
 * The anchors a verdict body carries, in the exact shape `review-body.ts`
 * emits them.
 *
 * `formatIssueBullet` renders every finding as `` `file:line` `` and every
 * strength as `` `file:line` ``; `buildInlinePrelude` renders a downgraded
 * inline comment as `**Inline comment (file:line)**`. So a path is only
 * evidence when it appears in one of those three shapes — the same shapes the
 * body is built from, not a second parser invented here.
 *
 * Deliberately NOT matched: a bare path in prose. `**Reasoning:**` and the
 * executive summary are model-authored text that legitimately names files the
 * PR does not touch ("this mirrors `lib/src/old.ts`"), and treating those as
 * evidence would make the guard fire on ordinary review prose.
 */
const ANCHOR_SHAPES: readonly RegExp[] = [
  // `path:line` inside an inline-code span. The capture excludes the line
  // number on purpose: a path is the evidence, `:12` is not part of it.
  /`([^`\n]+?\.[A-Za-z0-9_-]+):\d+`/g,
  // `**Inline comment (path:line)**`
  /\*\*Inline comment \(([^()\n]+?\.[A-Za-z0-9_-]+):\d+\)\*\*/g,
];

/**
 * Strip the zero-width spaces `review-body.ts` inserts after each `/` so an
 * anchor compares equal to the plain path the API reports.
 * @param value - Text that may contain U+200B.
 * @returns The same text without zero-width spaces.
 */
function stripZeroWidth(value: string): string {
  return value.replace(/\u200b/g, '');
}

/**
 * Normalise a path for membership comparison.
 *
 * The diff list from the API is repo-relative and clean; an anchor in a body
 * may carry a leading `./`, a trailing `:line`, or a leading `/`. None of
 * those is a different file, and a guard that reported `./lib/a.ts` and
 * `lib/a.ts` as two foreign paths would be inventing evidence.
 * @param value - Raw path text.
 * @returns A trimmed, `./`- and `/`-stripped, lowercased path.
 */
function normalizePath(value: string): string {
  let out = stripZeroWidth(value).trim();
  while (out.startsWith('./')) out = out.slice(2);
  while (out.startsWith('/')) out = out.slice(1);
  return out.toLowerCase();
}

/**
 * Extract the file paths a verdict body anchors to.
 *
 * Returns each distinct path once, in first-seen order, so the caller can
 * count DISTINCT foreign paths rather than counting repeated mentions of the
 * same file.
 * @param body - The review body markdown.
 * @returns Distinct normalised paths the body anchors to; empty when none.
 * @since NEXT
 */
export function extractVerdictBodyPaths(body: string | null | undefined): string[] {
  if (typeof body !== 'string' || body.trim() === '') return [];
  const found = new Set<string>();
  for (const shape of ANCHOR_SHAPES) {
    shape.lastIndex = 0;
    for (const match of body.matchAll(shape)) {
      const raw = match[1];
      if (!raw) continue;
      const path = normalizePath(raw);
      if (path !== '') found.add(path);
    }
  }
  return [...found];
}

/**
 * Paths in `paths` that are NOT in `changedFiles`.
 *
 * Comparison is normalised on both sides, so a diff entry of `lib/src/a.ts`
 * matches an anchor of `` `lib/src/a.ts:12` ``.
 * @param paths - Paths named by a verdict body.
 * @param changedFiles - Files the PR actually changes.
 * @returns The foreign paths, in the order they were given.
 */
function foreignPaths(paths: readonly string[], changedFiles: readonly string[]): string[] {
  // Optimized: Avoided intermediate array allocation from map() before Set creation
  const members = new Set<string>();
  for (const file of changedFiles) {
    members.add(normalizePath(file));
  }
  return paths.filter((p) => !members.has(p));
}

/**
 * Does this verdict body describe a different pull request?
 *
 * The check is deliberately one-directional. It fires only on a POSITIVE
 * mismatch — two or more distinct paths that are provably absent from this
 * PR's changed-file set — and stays silent on a short verdict, a verdict with
 * no anchors at all, or a verdict that names one foreign file. Absence of
 * evidence is not evidence of a mismatch, and a guard that fires on thin
 * evidence gets muted.
 *
 * @param body - The verdict body markdown.
 * @param changedFiles - Files the PR actually changes.
 * @param minForeignPaths - How many distinct foreign paths constitute a mismatch.
 * @returns The foreign paths when the verdict is a mismatch, otherwise null.
 * @since NEXT
 */
export function findMismatchedVerdictPaths(
  body: string | null | undefined,
  changedFiles: readonly string[] | null | undefined,
  minForeignPaths: number = DEFAULT_MIN_FOREIGN_PATHS,
): string[] | null {
  if (!Number.isFinite(minForeignPaths) || minForeignPaths < 1) return null;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return null;
  const named = extractVerdictBodyPaths(body);
  if (named.length === 0) return null;
  const foreign = foreignPaths(named, changedFiles);
  return foreign.length >= minForeignPaths ? foreign : null;
}

/**
 * Parse an ISO-8601 timestamp, returning null when it is absent, empty, or
 * unparseable. Malformed input must never compare as "newer than" a real
 * timestamp, which would flip a healthy PR red on a formatting quirk.
 * @param value - The raw timestamp value.
 * @returns Epoch milliseconds, or null when absent or unparseable.
 */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Newest review that actually delivered this action's verdict.
 *
 * A review qualifies when it was submitted by a recognised bot login **or**
 * when its body carries one of the action's signature markers. The signature
 * branch is what makes the guard work against a personal-access-token job,
 * whose reviews GitHub attributes to the human PAT owner — without it, every
 * genuine verdict reads as missing.
 *
 * `PENDING` and `DISMISSED` reviews never qualify: neither was delivered.
 * @param pull - The PR whose reviews are scanned.
 * @param botLogins - Logins whose reviews count as a delivered verdict.
 * @param bodySignatures - Body markers identifying an action-authored verdict.
 * @returns The newest qualifying review, or null when there is none.
 */
function newestBotReviewAt(
  pull: VerdictPull,
  botLogins: readonly string[],
  bodySignatures: readonly string[],
): { at: number; iso: string; commitId: string | null; body: string } | null {
  // Optimized: Avoided intermediate array allocation from map() before Set creation
  const bots = new Set<string>();
  for (const l of botLogins) {
    bots.add(l.toLowerCase());
  }
  const reviews = Array.isArray(pull.reviews) ? pull.reviews : [];
  let best: number | null = null;
  let bestCommitId: string | null = null;
  let bestBody = '';
  for (const review of reviews) {
    if (!review || typeof review !== 'object') continue;
    const state = typeof review.state === 'string' ? review.state.toUpperCase() : 'COMMENT';
    if (state === 'PENDING' || state === 'DISMISSED') continue;

    const login = review.user?.login;
    const byLogin = typeof login === 'string' && bots.has(login.toLowerCase());
    const body = typeof review.body === 'string' ? review.body : '';
    const bySignature = bodySignatures.some((sig) => sig !== '' && body.includes(sig));
    if (!byLogin && !bySignature) continue;

    const at = parseTimestamp(review.submitted_at);
    if (at === null) continue;
    if (best === null || at > best) {
      best = at;
      // Carried through deliberately: a verdict is only fresh if it names the
      // commit it read. Discarding this is what let a review posted minutes
      // after a NEWER commit landed certify code it never saw.
      bestCommitId =
        typeof review.commit_id === 'string' && review.commit_id.trim() !== ''
          ? review.commit_id.trim()
          : null;
      bestBody = body;
    }
  }
  if (best === null) return null;
  return { at: best, iso: new Date(best).toISOString(), commitId: bestCommitId, body: bestBody };
}

/**
 * Short SHA for a human-readable message; never throws.
 * @param sha - The SHA to abbreviate, possibly absent or non-string.
 * @returns The first seven characters, or `unknown` when unusable.
 */
function shortSha(sha: string | null | undefined): string {
  return typeof sha === 'string' && sha.trim() !== '' ? sha.trim().slice(0, 7) : 'unknown';
}

/**
 * Evaluate whether every open PR carries a verdict that is at least as new as
 * its head commit.
 *
 * Fail-closed on malformed evidence: an unparseable head date, an unknown
 * shape, or a missing field yields a `missing-verdict` violation rather than a
 * silent pass. A guard that fails open is worse than no guard, because it
 * converts an unknown into a green light.
 *
 * Skipped PRs are returned in `skipped` rather than dropped, so every
 * non-judgement is visible to whoever reads the check.
 *
 * Pure function (no I/O), safe to unit test.
 * @param pulls - Open PRs with their reviews and head-commit dates.
 * @param opts - Optional bot-login / exclusion / grace-window policy.
 * @returns A report listing violations, skips, and the judged count.
 * @since NEXT
 */
export function evaluateVerdictFreshness(
  pulls: readonly VerdictPull[],
  opts?: VerdictFreshnessOptions,
): VerdictFreshnessReport {
  const botLogins = opts?.botLogins ?? DEFAULT_BOT_LOGINS;
  const bodySignatures = opts?.bodySignatures ?? DEFAULT_BODY_SIGNATURES;
  const excludePrefixes = opts?.excludeBranchPrefixes ?? DEFAULT_EXCLUDED_BRANCH_PREFIXES;
  const headGraceMs = opts?.headGraceMs ?? DEFAULT_HEAD_GRACE_MS;
  const skewMs = opts?.skewMs ?? DEFAULT_SKEW_MS;
  const requireVerdictWithoutRun = opts?.requireVerdictWithoutRun !== false;
  const baseline = new Set(opts?.baseline ?? []);
  const now = opts?.now ?? Date.now();
  const minForeignPaths = opts?.minForeignPaths ?? DEFAULT_MIN_FOREIGN_PATHS;

  const violations: VerdictViolation[] = [];
  const indeterminate: VerdictIndeterminate[] = [];
  const skipped: VerdictSkip[] = [];
  let evaluated = 0;

  const list = Array.isArray(pulls) ? pulls : [];

  for (const pull of list) {
    if (!pull || typeof pull !== 'object' || !Number.isFinite(pull.number)) {
      skipped.push({ number: -1, reason: 'malformed PR record — could not judge' });
      continue;
    }

    const headRef = typeof pull.head_ref === 'string' ? pull.head_ref : '';

    // Evidence unreadable => INDETERMINATE, never a verdict claim.
    // "We could not look" and "there is nothing there" are opposite facts.
    // Reporting a failed fetch as a lost verdict is a lie about the world, and
    // it is how a guard gets switched off after one bad afternoon.
    if (typeof pull.reviewsFetchError === 'string' && pull.reviewsFetchError !== '') {
      indeterminate.push({
        number: pull.number,
        title: pull.title ?? '',
        url: pull.html_url ?? '',
        reason: `could not read reviews: ${pull.reviewsFetchError} — freshness is UNKNOWN, not lost`,
      });
      continue;
    }

    if (pull.draft === true) {
      skipped.push({ number: pull.number, reason: 'draft PR — not a merge candidate yet' });
      continue;
    }
    if (
      excludePrefixes.some(
        (prefix) => typeof prefix === 'string' && prefix !== '' && headRef.startsWith(prefix),
      )
    ) {
      skipped.push({
        number: pull.number,
        reason: `branch "${headRef}" is excluded — the review job never runs on "${prefixMatch(headRef, excludePrefixes)}" branches`,
      });
      continue;
    }

    const newest = newestBotReviewAt(pull, botLogins, bodySignatures);
    const hasCompletedRun = (pull.completedReviewRuns ?? 0) > 0;
    const headAt = parseTimestamp(pull.head_date);

    // In-flight run first, before ANY verdict rule. A head commit that is
    // still inside the grace window owes nothing yet, whether or not a review
    // has landed. Checking freshness first would flag every PR the instant it
    // is pushed and teach everyone to ignore the guard.
    if (headAt !== null && now - headAt < headGraceMs) {
      skipped.push({
        number: pull.number,
        reason: `head commit is ${Math.max(0, Math.round((now - headAt) / 60_000))}m old — still inside the ${Math.round(headGraceMs / 60_000)}m in-flight grace window`,
      });
      continue;
    }

    const base = {
      number: pull.number,
      title: pull.title ?? '',
      url: pull.html_url ?? '',
      headSha: shortSha(pull.head_sha),
    };

    // No qualifying verdict at all. Only a violation when the evidence says
    // one was owed: a completed run, or (by default) any open non-excluded PR.
    if (!newest) {
      if (!hasCompletedRun && !requireVerdictWithoutRun) {
        skipped.push({ number: pull.number, reason: 'no review run completed and none required' });
        continue;
      }
      evaluated++;
      violations.push({
        ...base,
        kind: 'missing-verdict',
        reason: hasCompletedRun
          ? `${pull.completedReviewRuns} AI review run(s) completed but no bot review is on the PR — the verdict was never posted`
          : 'open PR has no bot review and no review run is known to have completed',
        headDate: typeof pull.head_date === 'string' ? pull.head_date : undefined,
      });
      continue;
    }

    // Freshness needs BOTH halves of an identity, and this is the half that
    // used to be missing.
    //
    // A `submitted_at` newer than the head commit only proves the review was
    // POSTED late. It says nothing about what the review READ: the action
    // posts against `pr.headSha` resolved when the run started, so a run that
    // began before a push, or that raced one, submits a verdict minutes after
    // a newer commit landed while still describing the older code. Measured
    // live on 2026-10-02, twice (duoport #135, and this repo): such a verdict
    // looked 13m49s newer than the head it had never read.
    //
    // So commit identity is required, and an absent `commit_id` is treated as
    // NOT establishing freshness rather than falling back to the timestamp.
    // A verdict that cannot name the commit it read proves nothing about it.
    if (newest.commitId === null) {
      evaluated++;
      violations.push({
        ...base,
        kind: 'stale-verdict',
        reason:
          'the newest review carries no commit identity (commit_id absent), so it cannot be shown to describe this head — freshness fails closed',
        newestReviewAt: newest.iso,
        reviewedCommit: undefined,
      });
      continue;
    }

    if (newest.commitId !== pull.head_sha) {
      evaluated++;
      violations.push({
        ...base,
        kind: 'stale-verdict',
        reason: `the newest review (${newest.iso}) is newer than the head commit but describes commit ${shortSha(newest.commitId)}, not head ${base.headSha} — it was posted against older code`,
        newestReviewAt: newest.iso,
        reviewedCommit: newest.commitId,
        headDate: typeof pull.head_date === 'string' ? pull.head_date : undefined,
      });
      continue;
    }

    if (headAt === null) {
      // Fail closed: the head date is the whole comparison, and without it a
      // stale verdict is indistinguishable from a fresh one.
      evaluated++;
      violations.push({
        ...base,
        kind: 'stale-verdict',
        reason:
          'head commit date is missing or unparseable — freshness cannot be verified, so the verdict is treated as stale',
        newestReviewAt: newest.iso,
        reviewedCommit: newest.commitId,
      });
      continue;
    }

    if (headAt - newest.at > skewMs) {
      evaluated++;
      violations.push({
        ...base,
        kind: 'stale-verdict',
        reason: `head commit is newer than the newest bot review by ${Math.round((headAt - newest.at) / 60_000)}m — the verdict describes older code`,
        newestReviewAt: newest.iso,
        reviewedCommit: newest.commitId,
        headDate: new Date(headAt).toISOString(),
      });
      continue;
    }

    // The verdict names the right head commit and is newer than it. That still
    // does not make it a verdict about THIS pull request.
    //
    // `commit_id` is a commit identity, not a PR identity: a run that started
    // on another PR's head, or that raced a merge, can post a body whose
    // findings all belong to a DIFFERENT diff while carrying a perfectly valid
    // `commit_id`. Measured live on 2026-10-08 on reviewer #1041: the verdict
    // passed every freshness rule above while naming `action/src/audit.ts`,
    // `action.yml` and `audit.integration.test.ts` — none of which are in #1041's
    // diff; they belong to #982, merged 30 minutes earlier. A reader took its
    // "no blocking issue" as a statement about #1041.
    //
    // So the body's own anchors are checked against the PR's changed-file set.
    // This is the same anchor shape `review-body.ts` emits, not a second parser.
    const mismatch = findMismatchedVerdictPaths(newest.body, pull.changedFiles, minForeignPaths);
    if (mismatch) {
      evaluated++;
      violations.push({
        ...base,
        kind: 'mismatched-verdict',
        reason:
          `the verdict names ${mismatch.length} file(s) that are NOT in this PR's diff ` +
          `(${mismatch.map((p) => `\`${p}\``).join(', ')}) — it describes a different pull request, ` +
          `not #${pull.number}`,
        newestReviewAt: newest.iso,
        reviewedCommit: newest.commitId,
        headDate: typeof pull.head_date === 'string' ? pull.head_date : undefined,
      });
      continue;
    }

    evaluated++;
  }

  // Baseline split: known-bad PRs stay reported, but as debt rather than as a
  // blocker. The guard's job from its first run is to catch the NEXT lost
  // verdict; a backlog entry must not become a reason to ignore the check.
  const active = violations.filter((v) => !baseline.has(v.number));
  for (const v of violations) {
    if (!baseline.has(v.number)) continue;
    skipped.push({
      number: v.number,
      reason: `KNOWN VIOLATION (baseline) — ${v.kind}: ${v.reason} Remove from the baseline once this PR carries a verdict.`,
    });
  }

  active.sort((a, b) => a.number - b.number);
  skipped.sort((a, b) => a.number - b.number);
  indeterminate.sort((a, b) => a.number - b.number);
  // Fail closed on indeterminate: the guard cannot certify what it did not
  // read, so an unreadable PR is never an all-clear.
  return {
    ok: active.length === 0 && indeterminate.length === 0,
    violations: active,
    indeterminate,
    skipped,
    evaluated,
  };
}

/**
 * Return the exclusion prefix that matched a branch, for the skip message.
 * @param headRef - Branch name.
 * @param prefixes - Candidate prefixes.
 * @returns The matching prefix, or an empty string when none matched.
 */
function prefixMatch(headRef: string, prefixes: readonly string[]): string {
  const hit = prefixes.find((p) => typeof p === 'string' && p !== '' && headRef.startsWith(p));
  return hit ?? '';
}

/**
 * Render a {@link VerdictFreshnessReport} as an operator-facing markdown block.
 *
 * The three outcomes are rendered under three different headings, never
 * merged: a LOST verdict, an UNREADABLE verdict, and a deliberately
 * not-judged PR are three different claims, and an operator reading "verdict
 * lost" where the truth is "GitHub was unreachable" has been told a falsehood
 * by a safety check.
 * @param report - The report to render.
 * @returns Markdown suitable for `core.summary` or a job annotation.
 */
export function formatVerdictFreshnessReport(report: VerdictFreshnessReport): string {
  const lines: string[] = [];
  const indeterminate = report.indeterminate ?? [];

  if (report.ok) {
    lines.push(`### Verdict freshness: PASS (${report.evaluated} PR(s) judged)`);
  } else if (report.violations.length === 0 && indeterminate.length > 0) {
    lines.push(
      `### Verdict freshness: INCONCLUSIVE (${indeterminate.length} PR(s) could not be read — this is NOT a lost verdict)`,
    );
  } else {
    lines.push(`### Verdict freshness: FAIL (${report.violations.length} of ${report.evaluated})`);
  }

  for (const v of report.violations) {
    lines.push(`- **#${v.number}** \`${v.kind}\` — ${v.reason}`);
    if (v.url) lines.push(`  - ${v.url}`);
  }

  if (indeterminate.length > 0) {
    lines.push('');
    lines.push(
      `<details><summary>${indeterminate.length} PR(s) INDETERMINATE — evidence unreadable, verdict state unknown</summary>`,
    );
    lines.push('');
    for (const i of indeterminate) {
      lines.push(`- #${i.number} — ${i.reason}`);
    }
    lines.push('');
    lines.push('</details>');
  }

  if (report.skipped.length > 0) {
    lines.push('');
    lines.push(`<details><summary>${report.skipped.length} PR(s) not judged</summary>`);
    lines.push('');
    for (const s of report.skipped) {
      lines.push(`- #${s.number} — ${s.reason}`);
    }
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}
