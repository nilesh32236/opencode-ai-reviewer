/**
 * The trust block exists because a review pass that cannot read its input and a
 * review pass that finds nothing look identical from outside: both are
 * `issues: []`. These tests pin the distinction in both directions — a pass
 * that could not look must never report clean, and a pass that genuinely
 * looked and genuinely found nothing must still be able to say so.
 *
 * Every negative assertion here is paired with a positive one on the same
 * input, because the failure mode of this kind of feature is a test that
 * passes for the wrong reason (a filter that drops everything looks exactly
 * like a filter that works).
 */

import { describe, expect, it } from 'vitest';
import { resolveAnchor, resolveIssueAnchors } from '../src/utils/anchor-resolve.js';
import {
  CoverageLedger,
  PASS_LEARNING_STORE,
  PASS_LINTERS,
  PASS_SECRET_REVIEW,
  buildReviewTrust,
  deriveOutcome,
} from '../src/utils/coverage.js';

const SHA = '3990d3891ff6dd0c0a14ba4ee68d49b4b8182694';

describe('deriveOutcome', () => {
  it('never reports clean when something could not be read', () => {
    // The exact 37090355702 shape: 19 inputs enumerated, 0 readable.
    expect(deriveOutcome(0, 19, 0)).toBe('unreadable');
    // And the partial shape: some read, some not, nothing found.
    expect(deriveOutcome(4, 19, 0)).toBe('unreadable');
    expect(deriveOutcome(4, 19, 7)).toBe('unreadable');
  });

  it('distinguishes clean from skipped from findings', () => {
    expect(deriveOutcome(12, 0, 0)).toBe('clean');
    expect(deriveOutcome(12, 0, 3)).toBe('findings');
    expect(deriveOutcome(0, 0, 0)).toBe('skipped');
  });
});

describe('CoverageLedger', () => {
  it('records a pass that read nothing as unreadable rather than clean', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 0, 19, 0, 'ENOENT');
    const entry = ledger.get(PASS_SECRET_REVIEW);

    expect(entry?.outcome).toBe('unreadable');
    expect(entry?.scanned).toBe(0);
    expect(entry?.unreadable).toBe(19);
    expect(ledger.isComplete()).toBe(false);
    expect(ledger.unreadableTotal()).toBe(19);
  });

  it('treats a crashed pass as incomplete even though it read nothing', () => {
    const ledger = new CoverageLedger();
    ledger.record(PASS_LINTERS, 'failed', 0, 0, 'spawn ENOENT');
    expect(ledger.isComplete()).toBe(false);
    expect(ledger.get(PASS_LINTERS)?.reason).toBe('spawn ENOENT');
  });

  it('reports complete only when every pass actually read its inputs', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_LINTERS, 10, 0, 0);
    expect(ledger.isComplete()).toBe(true);
    expect(ledger.unreadableTotal()).toBe(0);
  });

  it('does not let a skipped pass masquerade as a clean one', () => {
    // "Nothing to look at" and "looked, found nothing" are different claims
    // and must stay different in the published accounting.
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_LINTERS, 0, 0, 0);
    expect(ledger.get(PASS_LINTERS)?.outcome).toBe('skipped');
  });

  it('keeps the last recording for a repeated pass', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_LINTERS, 5, 0, 0);
    ledger.recordCounts(PASS_LINTERS, 5, 2, 0, 'second batch unreadable');
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.get(PASS_LINTERS)?.unreadable).toBe(2);
  });
});

describe('buildReviewTrust', () => {
  it('says UNSCANNED, not clean, when inputs could not be read', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 0, 19, 0, 'ENOENT');

    const trust = buildReviewTrust(ledger, { headSha: SHA });

    expect(trust.exhaustive).toBe(false);
    expect(trust.failedClosed).toBe(true);
    expect(trust.statement).toContain('UNSCANNED');
    expect(trust.statement).toContain('Not an exhaustive review');
  });

  it('does not claim exhaustiveness for a run with no findings at all', () => {
    // The false green in its purest form: everything read, nothing found. That
    // is a legitimate outcome, but it is a claim about coverage, and it has to
    // be stated as one rather than inferred from an empty issue list.
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 46, 0, 0);
    ledger.recordCounts(PASS_LINTERS, 46, 0, 0);

    const trust = buildReviewTrust(ledger, { headSha: SHA, candidatesConsidered: 0, delivered: 0 });

    expect(trust.exhaustive).toBe(true);
    expect(trust.failedClosed).toBe(false);
    expect(trust.statement).toContain('Every pass read every input');
  });

  it('reports a budget-truncated run as not exhaustive', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 46, 0, 0);

    const trust = buildReviewTrust(ledger, { headSha: SHA, budgetTruncated: true });

    expect(trust.exhaustive).toBe(false);
    expect(trust.statement).toContain('truncated');
  });

  it('carries the 22%-agreement number the review actually produced', () => {
    // 50 candidates considered, 11 published — the real figure from
    // run 37090355702. The block has to carry it, because the finding list
    // alone makes 11 look like the complete set.
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 46, 0, 0);

    const trust = buildReviewTrust(ledger, {
      headSha: SHA,
      candidatesConsidered: 50,
      delivered: 11,
    });

    expect(trust.candidatesConsidered).toBe(50);
    expect(trust.candidatesDropped).toBe(39);
    expect(trust.findingRetention).toBeCloseTo(0.22, 2);
    expect(trust.statement).toContain('50 candidate finding(s)');
    expect(trust.statement).toContain('11 published');
  });

  it('reports retention as unknown rather than 100% when no candidate set was tracked', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 46, 0, 0);
    const trust = buildReviewTrust(ledger, { headSha: SHA });
    // The dangerous value here is 1. A null that renders as "unknown" is
    // honest; a null that renders as 100% is the false green all over again.
    expect(trust.findingRetention).toBeNull();
    expect(trust.findingRetention).not.toBe(1);
  });
});

describe('resolveAnchor', () => {
  const readFrom = (files: Record<string, string>) => async (file: string) => files[file];

  it('marks an anchor stale when the file is gone at the reviewed commit', async () => {
    const result = await resolveAnchor({ file: 'lib/src/gone.ts', line: 10 }, SHA, readFrom({}));
    expect(result.status).toBe('stale-anchor');
    expect(result.note).toContain('not available');
  });

  it('marks an anchor stale when the line is past the end of the file', async () => {
    const result = await resolveAnchor(
      { file: 'a.ts', line: 5000 },
      SHA,
      readFrom({ 'a.ts': 'one\ntwo\nthree\n' }),
    );
    expect(result.status).toBe('stale-anchor');
    expect(result.note).toContain('past the end');
  });

  it('marks an anchor stale when the file shifted under the line number', async () => {
    // The case that matters: a bounds check alone passes here, because line 3
    // still exists. Only comparing the captured source line catches that the
    // finding now points at different code.
    const shifted = readFrom({
      'a.ts': 'header\nheader\nconst unrelated = 1;\nconst unrelated2 = 2;\n',
    });
    const result = await resolveAnchor(
      { file: 'a.ts', line: 3, anchorText: 'const target = secret;' },
      SHA,
      shifted,
    );
    expect(result.status).toBe('stale-anchor');
    expect(result.note).toContain('no longer holds');
    expect(result.textVerified).toBe(true);
  });

  it('resolves ok when the captured source line still matches', async () => {
    const result = await resolveAnchor(
      { file: 'a.ts', line: 3, anchorText: '  const target = secret;  ' },
      SHA,
      readFrom({ 'a.ts': 'header\nheader\nconst target = secret;\n' }),
    );
    expect(result.status).toBe('ok');
    expect(result.textVerified).toBe(true);
  });

  it('does not claim a text check it never performed', async () => {
    // Existence-and-range only. Reported as ok but explicitly NOT verified,
    // so it cannot inflate the anchorsChecked count.
    const result = await resolveAnchor(
      { file: 'a.ts', line: 2 },
      SHA,
      readFrom({ 'a.ts': 'a\nb\n' }),
    );
    expect(result.status).toBe('ok');
    expect(result.textVerified).toBe(false);
  });

  it('treats an unreadable file as unresolved rather than passing it', async () => {
    const throwing = async () => {
      throw new Error('blob fetch failed');
    };
    const result = await resolveAnchor({ file: 'a.ts', line: 1 }, SHA, throwing);
    expect(result.status).toBe('stale-anchor');
  });

  it('rejects a finding with no line number', async () => {
    const result = await resolveAnchor({ file: 'a.ts', line: 0 }, SHA, readFrom({ 'a.ts': 'a\n' }));
    expect(result.status).toBe('stale-anchor');
    expect(result.note).toContain('not a valid');
  });
});

describe('resolveIssueAnchors', () => {
  it('stamps status on every finding and counts only genuinely verified ones', async () => {
    const files = {
      'good.ts': 'one\ntwo\nconst real = 1;\n',
      'moved.ts': 'one\ntwo\nconst unrelated = 9;\n',
    };
    const reader = async (file: string) => files[file];

    const issues = [
      { file: 'good.ts', line: 3, anchorText: 'const real = 1;' },
      { file: 'moved.ts', line: 3, anchorText: 'const target = secret;' },
      { file: 'missing.ts', line: 1, anchorText: 'anything' },
      { file: 'good.ts', line: 2 },
    ];

    const counts = await resolveIssueAnchors(issues, SHA, reader);

    expect(issues[0].anchorStatus).toBe('ok');
    expect(issues[1].anchorStatus).toBe('stale-anchor');
    expect(issues[1].anchorNote).toContain('no longer holds');
    expect(issues[2].anchorStatus).toBe('stale-anchor');
    // The fourth resolved by range only: ok, but not counted as checked.
    expect(issues[3].anchorStatus).toBe('ok');

    expect(counts.stale).toBe(2);
    expect(counts.checked).toBe(1);
  });

  it('does not throw when the reader explodes mid-batch', async () => {
    const reader = async () => {
      throw new Error('git unavailable');
    };
    const issues = [{ file: 'a.ts', line: 1 }];
    await expect(resolveIssueAnchors(issues, SHA, reader)).resolves.toMatchObject({ stale: 1 });
    expect(issues[0].anchorStatus).toBe('stale-anchor');
  });
});
