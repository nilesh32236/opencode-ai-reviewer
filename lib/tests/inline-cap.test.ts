import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewIssue, ReviewResult } from '../src/types/index.js';
import { GitHubHelper } from '../src/utils/github.js';
import {
  DEFAULT_INLINE_CAP,
  MAX_INLINE_CAP,
  formatOverflowSummary,
  normalizeInlineCap,
  resolveInlineCap,
  sortAndCapFindings,
} from '../src/utils/review-body.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRetryAndTimeout: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Controllable fault injection for the cap helper: the publisher must fail
// open to the legacy uncapped path when sorting/capping throws.
let mockCapShouldThrow = false;
vi.mock('../src/utils/review-body.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/review-body.js')>();
  return {
    ...mod,
    sortAndCapFindings: (...args: Parameters<typeof mod.sortAndCapFindings>) => {
      if (mockCapShouldThrow) throw new Error('cap boom');
      return mod.sortAndCapFindings(...args);
    },
  };
});

const TOKEN = 'test-token';
const REPO = 'owner/repo';

type Issue = ReviewResult['issues'][number];

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    type: 'issue',
    severity: 'important',
    file: 'src/a.ts',
    line: 1,
    message: 'Finding.',
    inline: true,
    ...overrides,
  };
}

function makeResult(issues: Issue[]): ReviewResult {
  return {
    summary: 'Review summary.',
    verdict: { ready: false, reasoning: 'Issues found.', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues,
    stats: {
      total: issues.length,
      critical: issues.filter((i) => i.severity === 'critical').length,
      important: issues.filter((i) => i.severity === 'important').length,
      minor: issues.filter((i) => i.severity === 'minor').length,
    },
  };
}

/** 15 mixed-severity findings on distinct on-diff lines. */
function makeMixedFifteen(): Issue[] {
  const severities: Array<Issue['severity']> = [
    'minor',
    'critical',
    'important',
    'minor',
    'critical',
    'important',
    'minor',
    'critical',
    'important',
    'minor',
    'critical',
    'important',
    'minor',
    'critical',
    'important',
  ];
  const confidences: Array<Issue['confidence']> = ['high', 'medium', 'low'];
  return severities.map((severity, i) =>
    makeIssue({
      severity,
      line: i + 1,
      message: `Finding ${i + 1} (${severity}).`,
      confidence: confidences[i % confidences.length],
    }),
  );
}

// Diff covering src/a.ts lines 1..15 so every finding is on-diff.
const DIFF_15_LINES = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index abc..def 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +1,15 @@',
  ...Array.from({ length: 15 }, (_, i) => `+line${i + 1}`),
].join('\n');

function makeMockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body ?? {}),
    text: vi.fn().mockResolvedValue(JSON.stringify(body ?? '')),
  } as unknown as Response;
}

function makeMockTextResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'text/plain' }),
    json: vi.fn().mockRejectedValue(new Error('Not JSON')),
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

describe('inline cap helpers', () => {
  it('defaults the cap to 10 clamped to 1-10', () => {
    expect(DEFAULT_INLINE_CAP).toBe(10);
    expect(MAX_INLINE_CAP).toBe(10);
    expect(normalizeInlineCap(undefined)).toBe(10);
    expect(normalizeInlineCap(null)).toBe(10);
    expect(normalizeInlineCap(Number.NaN)).toBe(10);
    expect(normalizeInlineCap(0)).toBe(10);
    expect(normalizeInlineCap(-3)).toBe(10);
    expect(normalizeInlineCap(5)).toBe(5);
    expect(normalizeInlineCap(7.9)).toBe(7);
    expect(normalizeInlineCap(99)).toBe(10);
  });

  it('resolves the cap with maxInlineComments > noiseBudget > default precedence', () => {
    expect(resolveInlineCap(undefined)).toBe(10);
    expect(resolveInlineCap({})).toBe(10);
    expect(resolveInlineCap({ disableInlineCap: true })).toBeUndefined();
    expect(resolveInlineCap({ maxInlineComments: 5 })).toBe(5);
    expect(resolveInlineCap({ maxInlineComments: 99 })).toBe(10);
    expect(resolveInlineCap({ maxVisibleFindings: 3 })).toBe(3);
    expect(resolveInlineCap({ noiseBudget: 4 })).toBe(4);
    expect(resolveInlineCap({ maxInlineComments: 5, maxVisibleFindings: 3 })).toBe(5);
  });

  it('sorts by severity (critical > important > minor) then confidence desc', () => {
    const issues = [
      makeIssue({ severity: 'minor', confidence: 'high', message: 'minor-high' }),
      makeIssue({ severity: 'critical', confidence: 'low', message: 'critical-low' }),
      makeIssue({ severity: 'important', confidence: 'high', message: 'important-high' }),
      makeIssue({ severity: 'critical', confidence: 'high', message: 'critical-high' }),
      makeIssue({ severity: 'important', confidence: 'low', message: 'important-low' }),
    ];
    const { inline, overflow, capped } = sortAndCapFindings(issues, { maxInlineComments: 10 });
    expect(capped).toBe(false);
    expect(overflow).toEqual([]);
    expect(inline.map((i) => (i as ReviewIssue).message)).toEqual([
      'critical-high',
      'critical-low',
      'important-high',
      'important-low',
      'minor-high',
    ]);
  });

  it('splits inline versus overflow under the cap', () => {
    const issues = makeMixedFifteen();
    const { inline, overflow, appliedCap, capped } = sortAndCapFindings(issues);
    expect(appliedCap).toBe(10);
    expect(capped).toBe(true);
    expect(inline).toHaveLength(10);
    expect(overflow).toHaveLength(5);
    // Severity-sorted: no minor survives while 5 criticals + 5 importants exist.
    expect(inline.every((i) => i.severity !== 'minor')).toBe(true);
    expect(overflow.every((i) => i.severity === 'minor')).toBe(true);
  });

  it('restores the legacy order when disableInlineCap is set', () => {
    const issues = makeMixedFifteen();
    const { inline, overflow, capped } = sortAndCapFindings(issues, { disableInlineCap: true });
    expect(capped).toBe(false);
    expect(overflow).toEqual([]);
    expect(inline).toHaveLength(15);
  });

  it('throws on non-array input so publishers can fail open', () => {
    expect(() => sortAndCapFindings(undefined as never)).toThrow();
  });

  it('renders one collapsible overflow table, empty when nothing was cut', () => {
    expect(formatOverflowSummary([])).toBe('');
    const { overflow } = sortAndCapFindings(makeMixedFifteen());
    const block = formatOverflowSummary(overflow);
    expect(block).toContain('<details><summary>');
    expect(block).toContain('5 more finding');
    expect(block).toContain('| File | Severity | Finding |');
    expect(block).toContain('MINOR');
  });
});

describe('postReview inline cap (acceptance criteria)', () => {
  let helper: GitHubHelper;
  let fetchMock: ReturnType<typeof vi.fn>;

  function reviewPosts(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter(
        ([url, options]: [string, RequestInit | undefined]) =>
          url.includes('/pulls/42/reviews') && (options?.method as string) === 'POST',
      )
      .map(([, options]) => JSON.parse((options as RequestInit).body as string));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCapShouldThrow = false;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    helper = new GitHubHelper(TOKEN, REPO);
    fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = (options?.method as string) || 'GET';
      if (urlStr.endsWith('/pulls/42') && method === 'GET') {
        return makeMockTextResponse(DIFF_15_LINES);
      }
      if (urlStr.includes('/pulls/42/reviews') && method === 'POST') {
        const payload = JSON.parse((options?.body as string) || '{}');
        const comments = payload.comments as Array<{ path: string; line: number }> | undefined;
        if (comments && comments.length > 0) {
          return makeMockResponse({
            id: 100,
            comments: comments.map((c, i) => ({ id: 10 + i, path: c.path, line: c.line })),
          });
        }
        return makeMockResponse({ id: 100 });
      }
      return makeMockResponse({});
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC1: 15 mixed findings with defaults posts exactly 10 severity-sorted inline + one overflow summary', async () => {
    const posted = await helper.postReview(42, 'sha123', makeResult(makeMixedFifteen()), true);
    expect(posted.success).toBe(true);

    const bodies = reviewPosts();
    expect(bodies).toHaveLength(1);
    const comments = bodies[0].comments as unknown[];
    expect(comments).toHaveLength(10);

    // Severity-sorted: every posted thread is critical/important, no minor.
    const threads = bodies[0].comments as Array<{ body: string }>;
    expect(threads.every((c) => /CRITICAL|IMPORTANT/.test(c.body))).toBe(true);
    expect(threads.some((c) => /MINOR/.test(c.body))).toBe(false);

    // Remainder renders as exactly one collapsible overflow summary.
    const reviewBody = bodies[0].body as string;
    expect(reviewBody.match(/<details><summary>/g)).toHaveLength(1);
    expect(reviewBody).toContain('5 more finding');
  });

  it('AC2: maxInlineComments 5 posts 5 inline with overflow of total minus 5', async () => {
    const posted = await helper.postReview(
      42,
      'sha123',
      makeResult(makeMixedFifteen()),
      true,
      undefined,
      {
        maxInlineComments: 5,
      },
    );
    expect(posted.success).toBe(true);

    const bodies = reviewPosts();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].comments as unknown[]).toHaveLength(5);
    expect(bodies[0].body as string).toContain('10 more finding');
  });

  it('AC3: cap helper throwing falls back to the legacy uncapped path with exit 0', async () => {
    mockCapShouldThrow = true;
    const posted = await helper.postReview(42, 'sha123', makeResult(makeMixedFifteen()), true);
    expect(posted.success).toBe(true);

    const bodies = reviewPosts();
    expect(bodies).toHaveLength(1);
    // Legacy path posts every eligible finding inline (no cap, no overflow).
    expect(bodies[0].comments as unknown[]).toHaveLength(15);
    expect(bodies[0].body as string).not.toContain('<details><summary>');
  });

  it('AC4: zero findings posts zero inline calls and no overflow block', async () => {
    const posted = await helper.postReview(42, 'sha123', makeResult([]), true);
    expect(posted.success).toBe(true);

    const bodies = reviewPosts();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('comments');
    expect(bodies[0].body as string).not.toContain('<details><summary>');
    expect(
      fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/pulls/42/comments')),
    ).toHaveLength(0);
  });

  it('disableInlineCap restores the legacy uncapped path', async () => {
    const posted = await helper.postReview(
      42,
      'sha123',
      makeResult(makeMixedFifteen()),
      true,
      undefined,
      {
        disableInlineCap: true,
      },
    );
    expect(posted.success).toBe(true);

    const bodies = reviewPosts();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].comments as unknown[]).toHaveLength(15);
    expect(bodies[0].body as string).not.toContain('<details><summary>');
  });
});
