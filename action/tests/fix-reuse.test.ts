import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  saveState: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: { actor: 'a', payload: {}, repo: { owner: 'o', repo: 'r' } },
  getOctokit: vi.fn(),
}));

vi.mock('@actions/exec', () => ({ exec: vi.fn() }));

import type { ReviewThreadInfo } from '@opencode-pr-agent/lib';
import { hasFixReReviewFlag } from '../src/comment-commands.js';
import {
  buildCleanReusedReviewResult,
  cleanReusedBody,
  filterHeadCurrentReuseThreads,
  findReusableHeadCurrentReview,
  getFixTriggerBody,
  hasReviewBodyFindingMarkers,
  isReviewStubBody,
  parseReusedSeverity,
  rehydrateReviewResultFromBotThreads,
  shouldForceFreshReview,
} from '../src/fix.js';

function thread(
  overrides: Partial<ReviewThreadInfo['firstComment']> & { body?: string } = {},
  top: Partial<ReviewThreadInfo> = {},
): ReviewThreadInfo {
  return {
    threadId: top.threadId ?? 't1',
    isResolved: top.isResolved ?? false,
    firstComment: {
      commentId: 'c1',
      databaseId: 101,
      body: overrides.body ?? '🔴 **critical**: bad',
      filePath: 'src/a.ts',
      lineNumber: 10,
      author: 'bot',
      createdAt: '2026-01-01T00:00:00Z',
      commitId: 'ABC123',
      ...overrides,
    },
  };
}

describe('parseReusedSeverity()', () => {
  it('anchors to the leading badge, not bare mentions', () => {
    expect(parseReusedSeverity('🔴 **critical**: sql injection')).toBe('critical');
    expect(parseReusedSeverity('🔵 **minor**: nit')).toBe('minor');
    expect(parseReusedSeverity('**important**: check this')).toBe('important');
  });

  it('does not escalate a finding that merely mentions critical', () => {
    expect(parseReusedSeverity('🔵 **minor**: not critical, just cleanup')).toBe('minor');
    expect(parseReusedSeverity('This is not critical, just cleanup')).toBe('important');
  });

  it('falls back to emoji when no badge is present', () => {
    expect(parseReusedSeverity('🔴 something broke')).toBe('critical');
    expect(parseReusedSeverity('plain note')).toBe('important');
  });
});

describe('isReviewStubBody()', () => {
  it('flags review-level failure phrases', () => {
    expect(isReviewStubBody('Review timed out, please retry')).toBe(true);
    expect(isReviewStubBody('Review result empty')).toBe(true);
    expect(isReviewStubBody('no meaningful content')).toBe(true);
    expect(isReviewStubBody('   ')).toBe(true);
  });

  it('keeps legitimate timeout findings reusable', () => {
    expect(isReviewStubBody('🔴 **critical**: missing timeout on fetch')).toBe(false);
    expect(isReviewStubBody('add request timeout to the client')).toBe(false);
  });
});

describe('hasFixReReviewFlag()', () => {
  it('matches /fix re-review variants', () => {
    expect(hasFixReReviewFlag('/fix re-review')).toBe(true);
    expect(hasFixReReviewFlag('/fix re_review')).toBe(true);
    expect(hasFixReReviewFlag('/fix force-review')).toBe(true);
    expect(hasFixReReviewFlag('/fix please')).toBe(false);
  });

  it('honors the /oc alias form', () => {
    expect(hasFixReReviewFlag('/oc fix re-review')).toBe(true);
    expect(hasFixReReviewFlag('/oc fix please')).toBe(false);
  });

  it('ignores tokens outside the command line', () => {
    expect(hasFixReReviewFlag('/fix please\n```\nre-review docs\n```')).toBe(false);
    expect(hasFixReReviewFlag(null)).toBe(false);
  });

  it('flows through shouldForceFreshReview', () => {
    expect(shouldForceFreshReview('/fix re-review')).toBe(true);
    expect(shouldForceFreshReview('/fix')).toBe(false);
  });
});

describe('findReusableHeadCurrentReview()', () => {
  const head = 'abc123';

  it('reuses via direct commitId (case-insensitive)', () => {
    const res = findReusableHeadCurrentReview([thread({ commitId: 'ABC123' })], head);
    expect(res).not.toBeNull();
    expect(res?.issues).toHaveLength(1);
  });

  it('reuses via the listReviewComments correlation map', () => {
    const t = thread({ commitId: undefined });
    const res = findReusableHeadCurrentReview([t], head, new Map([[101, 'abc123']]));
    expect(res).not.toBeNull();
  });

  it('rejects stale-head, resolved, and stub threads', () => {
    expect(findReusableHeadCurrentReview([thread({ commitId: 'deadbeef' })], head)).toBeNull();
    expect(
      findReusableHeadCurrentReview([thread({ commitId: 'abc123' }, { isResolved: true })], head),
    ).toBeNull();
    expect(
      findReusableHeadCurrentReview(
        [thread({ commitId: 'abc123', body: 'Review timed out' })],
        head,
      ),
    ).toBeNull();
  });
});

describe('filterHeadCurrentReuseThreads()', () => {
  it('returns only the reusable subset for id mapping', () => {
    const good = thread({ commitId: 'abc123' });
    const stale = { ...thread({ commitId: 'deadbeef' }), threadId: 'stale' };
    const stub = { ...thread({ commitId: 'abc123', body: 'Review timed out' }), threadId: 'stub' };
    const out = filterHeadCurrentReuseThreads([good, stale, stub], 'abc123');
    expect(out.map((t) => t.threadId)).toEqual(['t1']);
  });

  it('matches on originalCommitId when commitId is absent or differs', () => {
    const viaOriginal = thread({ commitId: undefined, originalCommitId: 'abc123' });
    expect(filterHeadCurrentReuseThreads([viaOriginal], 'abc123')).toHaveLength(1);
    const bothDiffer = thread({ commitId: 'sha-new', originalCommitId: 'abc123' });
    expect(filterHeadCurrentReuseThreads([bothDiffer], 'abc123')).toHaveLength(1);
    expect(filterHeadCurrentReuseThreads([bothDiffer], 'sha-new')).toHaveLength(1);
  });
});

describe('hasReviewBodyFindingMarkers()', () => {
  it('flags badge, issues-heading, and severity-emoji markers', () => {
    expect(hasReviewBodyFindingMarkers('🔴 **critical**: sql injection')).toBe(true);
    expect(hasReviewBodyFindingMarkers('### Issues\n- 🔵 **MINOR:** nit')).toBe(true);
    expect(hasReviewBodyFindingMarkers('needs work 🟠')).toBe(true);
  });

  it('treats empty/summary-only bodies as clean', () => {
    expect(hasReviewBodyFindingMarkers('')).toBe(false);
    expect(hasReviewBodyFindingMarkers('## MR Review Summary\n\nAll clean.')).toBe(false);
    // 🟢 marks ready/clean summaries, not findings — and unrelated emoji
    // (surrogate-pair neighbors) must not trip the severity-emoji class.
    expect(hasReviewBodyFindingMarkers('All good 🟢')).toBe(false);
    expect(hasReviewBodyFindingMarkers('All good 🎉')).toBe(false);
  });
});

describe('getFixTriggerBody()', () => {
  it('reads pull_request_review payload bodies', async () => {
    const github = await import('@actions/github');
    const ctx = github.context as unknown as { payload: Record<string, unknown> };
    const saved = ctx.payload;
    try {
      ctx.payload = { review: { body: '/fix re-review' } };
      expect(getFixTriggerBody()).toBe('/fix re-review');
      expect(shouldForceFreshReview(getFixTriggerBody())).toBe(true);
      ctx.payload = {};
      expect(getFixTriggerBody()).toBe('');
    } finally {
      ctx.payload = saved;
    }
  });
});

describe('rehydrate + clean helpers', () => {
  it('rehydrates unresolved threads and skips resolved/stub/empty', () => {
    const res = rehydrateReviewResultFromBotThreads(
      [
        thread({ commitId: 'abc123' }),
        thread({ commitId: 'abc123' }, { isResolved: true, threadId: 'r' }),
        thread({ commitId: 'abc123', body: 'Review timed out' }, { threadId: 's' }),
      ],
      'abc123',
    );
    expect(res?.issues).toHaveLength(1);
    expect(res?.issues[0]?.previouslyReported).toBe(true);
  });

  it('returns null when nothing usable remains', () => {
    expect(rehydrateReviewResultFromBotThreads([], 'abc123')).toBeNull();
  });

  it('builds a ready verdict for clean (zero-thread) reuse', () => {
    const res = buildCleanReusedReviewResult('abc123');
    expect(res.verdict.ready).toBe(true);
    expect(res.issues).toHaveLength(0);
    expect(res.summary).toContain('0 open finding');
  });

  it('strips fingerprint markers', () => {
    expect(cleanReusedBody('hello <!-- inline-fp:db8a4412f64a1924 -->')).toBe('hello');
  });
});
