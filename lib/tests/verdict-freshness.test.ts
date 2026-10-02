/**
 * L-054 repo-level guard: the check that makes a late or lost verdict
 * impossible to miss.
 *
 * The red fixture is the real incident: duoport #135 @ 2a566700, where the
 * `AI Code Review` job completed SUCCESS with a computed verdict
 * (`ready=False`, 22 issues) and ZERO reviews on the PR at the moment the
 * checks were read. A review only appeared hours later. Every healthy shape is
 * pinned alongside it so the guard cannot be "made green" by loosening it.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_LOGINS,
  type VerdictPull,
  evaluateVerdictFreshness,
  formatVerdictFreshnessReport,
} from '../src/utils/verdict-freshness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Fixed clock so "inside the grace window" is deterministic. Every case goes
 * through {@link evaluate}, which pins this — without the pin, a fixture built
 * as "2 minutes old" silently becomes "2 hours old" once the suite runs long
 * enough, and the guard's own tests start failing on a timer.
 */
const NOW = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

/** Evaluate against the pinned clock; per-test opts still win. */
function evaluate(
  pulls: readonly VerdictPull[],
  opts?: Parameters<typeof evaluateVerdictFreshness>[1],
): ReturnType<typeof evaluateVerdictFreshness> {
  return evaluateVerdictFreshness(pulls, { now: NOW, ...opts });
}

/**
 * The incident, verbatim in shape: job green, verdict computed, zero reviews
 * on the PR at read time. `completedReviewRuns: 1` records that a review run
 * DID finish — that is what separates "lost" from "has not run yet".
 */
const DUOPORT_135_LOST: VerdictPull = {
  number: 135,
  title: 'probe unknown-fallback and drift recovery',
  html_url: 'https://github.com/duoport/repo/pull/135',
  head_ref: 'fix/probe-unknown-fallback-and-drift-recovery',
  head_sha: '2a566700deadbeef',
  head_date: ago(2 * HOUR),
  labels: [],
  reviews: [],
  completedReviewRuns: 1,
};

/**
 * The same PR hours later, once a retried run finally delivered. Still the
 * same head commit, so the late verdict is now fresh enough to pass.
 */
const DUOPORT_135_RECOVERED: VerdictPull = {
  ...DUOPORT_135_LOST,
  reviews: [
    {
      id: 900,
      user: { login: 'opencode-ai-reviewer[bot]' },
      submitted_at: ago(90 * MINUTE),
      commit_id: '2a566700deadbeef',
    },
  ],
};

describe('evaluateVerdictFreshness — the L-054 fixture', () => {
  it('FAILS on duoport #135 at read time (green job, zero reviews)', () => {
    const report = evaluate([DUOPORT_135_LOST]);

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      number: 135,
      kind: 'missing-verdict',
      headSha: '2a56670',
    });
    expect(report.violations[0].reason).toContain('no bot review is on the PR');
  });

  it('PASSES on the same PR once the late verdict landed', () => {
    const report = evaluate([DUOPORT_135_RECOVERED]);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.evaluated).toBe(1);
  });

  it('FAILS when a verdict predates the head commit (push after review)', () => {
    // The common shape: reviewed, then someone pushed. The verdict now
    // describes code that is no longer on the branch.
    const report = evaluate([
      {
        number: 200,
        title: 'reviewed then pushed',
        head_ref: 'feature/x',
        head_sha: 'abc1234',
        head_date: ago(30 * MINUTE),
        reviews: [
          {
            id: 1,
            user: { login: 'opencode-ai-reviewer[bot]' },
            submitted_at: ago(3 * HOUR),
          },
        ],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('stale-verdict');
    expect(report.violations[0].reason).toContain('newer than the newest bot review');
  });

  it('PASSES a verdict posted after the head commit', () => {
    const report = evaluate([
      {
        number: 201,
        head_ref: 'feature/y',
        head_sha: 'abc1234',
        head_date: ago(3 * HOUR),
        reviews: [
          {
            id: 1,
            user: { login: 'opencode-ai-reviewer[bot]' },
            submitted_at: ago(20 * MINUTE),
          },
        ],
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('tolerates same-second commit/review ordering within clock skew', () => {
    // The head commit and the review are effectively simultaneous; a strict
    // `>` would flap red every time CI races the review.
    const report = evaluate([
      {
        number: 202,
        head_ref: 'feature/z',
        head_sha: 'abc1234',
        head_date: ago(2 * HOUR),
        reviews: [
          {
            id: 1,
            user: { login: 'opencode-ai-reviewer[bot]' },
            submitted_at: ago(2 * HOUR + 30_000),
          },
        ],
      },
    ]);

    expect(report.ok).toBe(true);
  });
});

describe('evaluateVerdictFreshness — healthy PRs must stay green', () => {
  it('PASSES a batch of currently-healthy reviewed PRs', () => {
    const healthy: VerdictPull[] = [1, 2, 3, 4, 5].map((n) => ({
      number: n,
      title: `healthy PR ${n}`,
      html_url: `https://github.com/o/r/pull/${n}`,
      head_ref: `feat/thing-${n}`,
      head_sha: `sha${n}`,
      head_date: ago(2 * DAY),
      reviews: [
        {
          id: n,
          user: { login: 'opencode-ai-reviewer[bot]' },
          submitted_at: ago(2 * DAY - 10 * MINUTE),
        },
      ],
      completedReviewRuns: 1,
    }));

    const report = evaluate(healthy);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.evaluated).toBe(5);
    expect(report.skipped).toEqual([]);
  });

  it('PASSES an empty fleet (no open PRs)', () => {
    expect(evaluate([])).toMatchObject({ ok: true, evaluated: 0 });
  });

  it('PASSES when a human review exists but no bot review is owed', () => {
    // A human approval is not an AI verdict. With no run completed and
    // requireVerdictWithoutRun off, this stays green rather than blaming a
    // human for the bot's silence.
    const report = evaluate(
      [
        {
          number: 300,
          head_ref: 'feature/human',
          head_sha: 'abc1234',
          head_date: ago(DAY),
          reviews: [{ id: 1, user: { login: 'somehuman' }, submitted_at: ago(HOUR) }],
        },
      ],
      { requireVerdictWithoutRun: false },
    );

    expect(report.ok).toBe(true);
    expect(report.skipped[0].reason).toContain('no review run completed');
  });

  it('does not let a human review mask a lost bot verdict', () => {
    const report = evaluate([
      {
        number: 301,
        head_ref: 'feature/human2',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        reviews: [{ id: 1, user: { login: 'somehuman' }, submitted_at: ago(HOUR) }],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('missing-verdict');
  });

  it('ignores a PENDING review (never delivered)', () => {
    const report = evaluate([
      {
        number: 302,
        head_ref: 'feature/pending',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        reviews: [
          {
            id: 1,
            user: { login: 'opencode-ai-reviewer[bot]' },
            state: 'PENDING',
            submitted_at: ago(HOUR),
          },
        ],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('missing-verdict');
  });

  it('ignores a DISMISSED review', () => {
    const report = evaluate([
      {
        number: 303,
        head_ref: 'feature/dismissed',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        reviews: [
          {
            id: 1,
            user: { login: 'opencode-ai-reviewer[bot]' },
            state: 'DISMISSED',
            submitted_at: ago(HOUR),
          },
        ],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(false);
  });

  it('accepts an APPROVE as a delivered verdict', () => {
    const report = evaluate([
      {
        number: 304,
        head_ref: 'feature/approved',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        reviews: [
          {
            id: 1,
            user: { login: 'opencode-ai-reviewer[bot]' },
            state: 'APPROVE',
            submitted_at: ago(HOUR),
          },
        ],
      },
    ]);

    expect(report.ok).toBe(true);
  });

  it('matches the bot login case-insensitively', () => {
    const report = evaluate([
      {
        number: 305,
        head_ref: 'feature/case',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        reviews: [{ id: 1, user: { login: 'OpenCode-AI-Reviewer[bot]' }, submitted_at: ago(HOUR) }],
      },
    ]);

    expect(report.ok).toBe(true);
  });
});

describe('evaluateVerdictFreshness — exclusions and in-flight runs', () => {
  it('does not judge an in-flight run (head too young)', () => {
    // The review job is still running. Flagging this would make the guard flap
    // red on every single PR push.
    const report = evaluate([
      {
        number: 400,
        head_ref: 'feature/inflight',
        head_sha: 'abc1234',
        head_date: ago(2 * MINUTE),
        reviews: [],
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.skipped[0].reason).toContain('in-flight grace window');
  });

  it('does not judge draft PRs', () => {
    const report = evaluate([
      { number: 401, head_ref: 'feature/draft', head_sha: 'abc', head_date: ago(DAY), draft: true },
    ]);

    expect(report.ok).toBe(true);
    expect(report.skipped[0].reason).toContain('draft PR');
  });

  it('excludes autofix/ branches by default, and says so out loud', () => {
    // ai-review.yml structurally refuses to review autofix/* branches. The
    // exclusion must be explicit and visible, never a silent filter.
    const report = evaluate([
      {
        number: 402,
        head_ref: 'autofix/issue-721',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        reviews: [],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.skipped[0].reason).toContain('autofix/');
    expect(formatVerdictFreshnessReport(report)).toContain('autofix/');
  });

  it('excludes improvement/ branches by default', () => {
    const report = evaluate([
      {
        number: 403,
        head_ref: 'improvement/run-12-attempt-1',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        reviews: [],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.skipped[0].reason).toContain('improvement/');
  });

  it('still judges an excluded prefix when the caller opts out', () => {
    const report = evaluate(
      [
        {
          number: 404,
          head_ref: 'autofix/issue-721',
          head_sha: 'abc1234',
          head_date: ago(DAY),
          reviews: [],
          completedReviewRuns: 1,
        },
      ],
      { excludeBranchPrefixes: [] },
    );

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('missing-verdict');
  });

  it('honours custom bot logins', () => {
    const report = evaluate(
      [
        {
          number: 405,
          head_ref: 'feature/custom',
          head_sha: 'abc1234',
          head_date: ago(DAY),
          reviews: [{ id: 1, user: { login: 'my-reviewer-bot' }, submitted_at: ago(HOUR) }],
        },
      ],
      { botLogins: ['my-reviewer-bot'] },
    );

    expect(report.ok).toBe(true);
  });
});

describe('evaluateVerdictFreshness — fails closed on garbage', () => {
  it('treats an unparseable head date as stale rather than fresh', () => {
    // Failing open here would convert "unknown" into a green light, which is
    // worse than having no guard at all.
    const report = evaluate([
      {
        number: 500,
        head_ref: 'feature/baddate',
        head_sha: 'abc1234',
        head_date: 'not-a-date',
        reviews: [{ id: 1, user: { login: 'opencode-ai-reviewer[bot]' }, submitted_at: ago(HOUR) }],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('stale-verdict');
    expect(report.violations[0].reason).toContain('unparseable');
  });

  it('treats a missing head date as stale', () => {
    const report = evaluate([
      {
        number: 501,
        head_ref: 'feature/nodate',
        head_sha: 'abc1234',
        head_date: null,
        reviews: [{ id: 1, user: { login: 'opencode-ai-reviewer[bot]' }, submitted_at: ago(HOUR) }],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('stale-verdict');
  });

  it('ignores reviews with an unparseable submitted_at rather than counting them', () => {
    const report = evaluate([
      {
        number: 502,
        head_ref: 'feature/badreview',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        reviews: [
          {
            id: 1,
            user: { login: 'opencode-ai-reviewer[bot]' },
            submitted_at: 'garbage',
          },
        ],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('missing-verdict');
  });

  it('does not throw on a non-array input', () => {
    expect(evaluate(null as unknown as VerdictPull[]).ok).toBe(true);
    expect(evaluate(undefined as unknown as VerdictPull[]).ok).toBe(true);
  });

  it('does not throw on malformed PR and review records', () => {
    const report = evaluate([
      { number: Number.NaN, head_sha: 'x' },
      { number: 600, head_sha: 'x', head_date: ago(DAY), reviews: [null, 7 as never] },
    ] as unknown as VerdictPull[]);

    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.number)).toContain(600);
  });

  it('accepts both string and object label shapes without throwing', () => {
    const report = evaluate([
      {
        number: 601,
        head_ref: 'feature/labels',
        head_sha: 'abc1234',
        head_date: ago(DAY),
        labels: ['bug', { name: 'autofix' }, {}],
        reviews: [{ id: 1, user: { login: 'opencode-ai-reviewer[bot]' }, submitted_at: ago(HOUR) }],
      },
    ]);

    expect(report.ok).toBe(true);
  });
});

describe('reviewer identity — a PAT job is attributed to its human owner', () => {
  /**
   * Regression guard for a false positive this suite actually shipped once:
   * every review in this repo is authored by `nilesh32236` because the job
   * runs on `secrets.GH_PAT`, which GitHub attributes to the human owner, not
   * to a `[bot]` login. An allowlist-only identity check then reported all
   * five open non-autofix PRs as "the verdict was never posted" — and every
   * one of them had in fact been reviewed.
   */
  const PAT_REVIEW_BODY = [
    '## Executive Summary',
    '',
    '**Purpose:** Adds a design note.',
    '',
    '## MR Review Summary',
    '',
    '**Ready to merge?** No',
    '**Merge-readiness:** needs work 0/5',
    '**Reasoning:** Claims in the note do not survive checking.',
  ].join('\n');

  it('recognises a PAT-authored review by its body signature', () => {
    const report = evaluate([
      {
        number: 986,
        head_ref: 'docs/credential-class-job-split',
        head_sha: 'abc1234',
        head_date: ago(3 * HOUR),
        reviews: [
          {
            id: 1,
            user: { login: 'nilesh32236' },
            submitted_at: ago(2 * HOUR),
            body: PAT_REVIEW_BODY,
          },
        ],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('still flags a PR whose only reviews are PAT-owned but lack the signature', () => {
    // A human who happens to own the PAT must not be able to mask a lost
    // verdict by leaving an ordinary review.
    const report = evaluate([
      {
        number: 987,
        head_ref: 'feature/human-only',
        head_sha: 'abc1234',
        head_date: ago(3 * HOUR),
        reviews: [
          {
            id: 1,
            user: { login: 'nilesh32236' },
            submitted_at: ago(2 * HOUR),
            body: 'LGTM, shipping it.',
          },
        ],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('missing-verdict');
  });

  it('treats a bare LGTM from a bot login as delivered (explicit allowlist wins)', () => {
    const report = evaluate([
      {
        number: 988,
        head_ref: 'feature/bot',
        head_sha: 'abc1234',
        head_date: ago(3 * HOUR),
        reviews: [
          {
            id: 1,
            user: { login: 'opencode-ai-reviewer[bot]' },
            submitted_at: ago(2 * HOUR),
            body: 'Looks fine.',
          },
        ],
      },
    ]);

    expect(report.ok).toBe(true);
  });

  it('compares freshness against a PAT-authored verdict, not just its presence', () => {
    const report = evaluate([
      {
        number: 989,
        head_ref: 'feature/pat-stale',
        head_sha: 'abc1234',
        head_date: ago(HOUR),
        reviews: [
          {
            id: 1,
            user: { login: 'nilesh32236' },
            submitted_at: ago(5 * HOUR),
            body: PAT_REVIEW_BODY,
          },
        ],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('stale-verdict');
  });

  it('ignores a PENDING PAT review (never delivered)', () => {
    const report = evaluate([
      {
        number: 990,
        head_ref: 'feature/pat-pending',
        head_sha: 'abc1234',
        head_date: ago(3 * HOUR),
        reviews: [
          {
            id: 1,
            user: { login: 'nilesh32236' },
            state: 'PENDING',
            submitted_at: ago(HOUR),
            body: PAT_REVIEW_BODY,
          },
        ],
        completedReviewRuns: 1,
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('missing-verdict');
  });

  it('honours a caller that disables signature matching', () => {
    const report = evaluate(
      [
        {
          number: 991,
          head_ref: 'feature/no-sig',
          head_sha: 'abc1234',
          head_date: ago(3 * HOUR),
          reviews: [
            {
              id: 1,
              user: { login: 'nilesh32236' },
              submitted_at: ago(HOUR),
              body: PAT_REVIEW_BODY,
            },
          ],
          completedReviewRuns: 1,
        },
      ],
      { bodySignatures: [] },
    );

    expect(report.ok).toBe(false);
    expect(report.violations[0].kind).toBe('missing-verdict');
  });

  it('recognises the signature across all five PRs the allowlist-only check flagged', () => {
    const report = evaluate(
      [845, 949, 957, 982, 986].map((n) => ({
        number: n,
        head_ref: `feature/pr-${n}`,
        head_sha: `sha${n}`,
        head_date: ago(2 * HOUR),
        reviews: [
          {
            id: n,
            user: { login: 'nilesh32236' },
            submitted_at: ago(HOUR),
            body: PAT_REVIEW_BODY,
          },
        ],
        completedReviewRuns: 1,
      })),
    );

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.evaluated).toBe(5);
  });
});

describe('baseline (known backlog)', () => {
  it('PASSES when every violation is in the baseline', () => {
    const report = evaluate([DUOPORT_135_LOST], { baseline: [135] });

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('still names a baselined violation as debt, so it is never invisible', () => {
    const report = evaluate([DUOPORT_135_LOST], { baseline: [135] });

    const entry = report.skipped.find((s) => s.number === 135);
    expect(entry?.reason).toContain('KNOWN VIOLATION');
    expect(entry?.reason).toContain('missing-verdict');
    expect(formatVerdictFreshnessReport(report)).toContain('#135');
  });

  it('FAILS on a NEW violation even while the backlog is baselined', () => {
    // The whole point of the baseline: hold the line on the next loss.
    const report = evaluate(
      [DUOPORT_135_LOST, { ...DUOPORT_135_LOST, number: 136, head_ref: 'fix/other' }],
      { baseline: [135] },
    );

    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.number)).toEqual([136]);
  });

  it('does not make a baselined PR un-failable if it later gets worse', () => {
    // A baselined `missing-verdict` that becomes `stale-verdict` is new debt
    // of a different kind; the baseline matches on PR number, so the operator
    // must consciously refresh it.
    const report = evaluate(
      [
        {
          number: 135,
          head_ref: 'fix/x',
          head_sha: 'abc1234',
          head_date: ago(DAY),
          reviews: [
            { id: 1, user: { login: 'opencode-ai-reviewer[bot]' }, submitted_at: ago(3 * DAY) },
          ],
        },
      ],
      { baseline: [135] },
    );

    expect(report.ok).toBe(true);
    expect(report.skipped[0].reason).toContain('stale-verdict');
  });

  it('leaves a non-baselined healthy PR alone', () => {
    const report = evaluate([DUOPORT_135_RECOVERED], { baseline: [999] });
    expect(report.ok).toBe(true);
    expect(report.skipped).toEqual([]);
  });
});

describe('formatVerdictFreshnessReport()', () => {
  it('renders a PASS line with the judged count', () => {
    const report = evaluate([DUOPORT_135_RECOVERED]);
    expect(formatVerdictFreshnessReport(report)).toContain('PASS (1 PR(s) judged)');
  });

  it('renders a FAIL line naming each violated PR and its kind', () => {
    const md = formatVerdictFreshnessReport(evaluate([DUOPORT_135_LOST]));
    expect(md).toContain('FAIL');
    expect(md).toContain('#135');
    expect(md).toContain('missing-verdict');
    expect(md).toContain('https://github.com/duoport/repo/pull/135');
  });

  it('lists skipped PRs so an exclusion is never invisible', () => {
    const md = formatVerdictFreshnessReport(
      evaluate([
        {
          number: 700,
          head_ref: 'autofix/issue-1',
          head_sha: 'abc',
          head_date: ago(DAY),
          reviews: [],
        },
      ]),
    );
    expect(md).toContain('1 PR(s) not judged');
    expect(md).toContain('#700');
  });
});

describe('default policy', () => {
  it('recognises the three fleet bot logins', () => {
    expect(DEFAULT_BOT_LOGINS).toContain('opencode-ai-reviewer[bot]');
    expect(DEFAULT_BOT_LOGINS).toContain('github-actions[bot]');
  });
});
