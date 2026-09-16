import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../src/config.js';
import type { ReviewResult } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import {
  GitHubHelper,
  buildChecksSummary,
  buildFingerprintCommentIds,
  normalizeFingerprintCommentIds,
  resolveChecksConclusion,
} from '../src/utils/github.js';
import { fingerprintForIssue } from '../src/utils/inline-fingerprint.js';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  return { warning, info, debug };
});

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRetryAndTimeout: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const TOKEN = 'test-token';
const REPO = 'owner/repo';

function mockResponse(overrides: Partial<Response> & { body?: unknown } = {}): Response {
  const headers = new Headers(
    (overrides as Record<string, unknown>).headers as Record<string, string> | undefined,
  );
  const { body, ...rest } = overrides;
  return {
    ok: true,
    status: 200,
    headers,
    json: vi.fn().mockResolvedValue(body ?? {}),
    text: vi.fn().mockResolvedValue(body !== undefined ? JSON.stringify(body) : ''),
    ...rest,
  } as unknown as Response;
}

function mockErrorResponse(status: number, statusText = 'Error'): Response {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    json: vi.fn().mockRejectedValue(new Error('Not JSON')),
    text: vi.fn().mockResolvedValue(statusText),
  } as unknown as Response;
}

function sampleReviewResult(): ReviewResult {
  return {
    summary: 'Review summary.',
    verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'medium' },
    strengths: [],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/b.ts',
        line: 42,
        message: 'Bug.',
        suggestion: 'Fix it.',
        inline: true,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
  };
}

const DIFF_TEXT = `@@ -42,1 +42,1 @@`;

function isDiffFetch(url: string): boolean {
  return (
    url.includes('/pulls/42') &&
    !url.includes('/reviews') &&
    !url.includes('/comments') &&
    !url.includes('/files') &&
    !url.includes('/check-runs')
  );
}

describe('review update-in-place + Checks summary', () => {
  let helper: GitHubHelper;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    helper = new GitHubHelper(TOKEN, REPO);
  });

  describe('resolveChecksConclusion', () => {
    it('maps ready verdicts to success', () => {
      const result = {
        ...sampleReviewResult(),
        verdict: { ...sampleReviewResult().verdict, ready: true },
      };
      expect(resolveChecksConclusion(result)).toBe('success');
    });

    it('maps not-ready verdicts to failure', () => {
      expect(resolveChecksConclusion(sampleReviewResult())).toBe('failure');
    });

    it('maps partial reviews to neutral', () => {
      const result = { ...sampleReviewResult(), failedBatches: 1 };
      expect(resolveChecksConclusion(result)).toBe('neutral');
    });
  });

  describe('buildChecksSummary', () => {
    it('carries deterministic counts', () => {
      const out = buildChecksSummary(sampleReviewResult());
      expect(out.title).toContain('1 critical');
      expect(out.summary).toContain('critical: 1');
      expect(out.summary).toContain('Ready to merge: No');
    });

    it('marks partial reviews in the title', () => {
      const out = buildChecksSummary({ ...sampleReviewResult(), failedAgents: 2 });
      expect(out.title).toContain('partial');
    });
  });

  describe('fingerprint comment-id maps', () => {
    it('builds fp → comment-id from bot threads and skips bad entries', () => {
      const fp = fingerprintForIssue({
        file: 'src/b.ts',
        line: 42,
        severity: 'critical',
        message: 'Bug.',
        suggestion: 'Fix it.',
      });
      const map = buildFingerprintCommentIds([
        { body: `note\n\n<!-- inline-fp:${fp} -->`, commentId: 555 },
        { body: 'no marker here', commentId: 556 },
        { body: `note\n\n<!-- inline-fp:${fp} -->`, commentId: 0 },
      ]);
      expect(map.get(fp)).toBe(555);
      expect(map.size).toBe(1);
    });

    it('normalizes Maps and records, rejecting invalid ids', () => {
      const fp = 'a'.repeat(16);
      expect(normalizeFingerprintCommentIds(new Map([[fp, 7]])).get(fp)).toBe(7);
      expect(normalizeFingerprintCommentIds({ [fp]: 7 }).get(fp)).toBe(7);
      expect(normalizeFingerprintCommentIds({ [fp]: 0 }).size).toBe(0);
      expect(normalizeFingerprintCommentIds(undefined).size).toBe(0);
    });
  });

  describe('updateReviewComment', () => {
    it('PATCHes the review comment and returns true', async () => {
      fetchMock.mockImplementation(async () => mockResponse({ body: {} }));
      const ok = await helper.updateReviewComment(555, 'fresh body');
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/pulls/comments/555');
      expect(options?.method).toBe('PATCH');
      expect(options?.body).toContain('fresh body');
    });

    it('fails open (false) when the API errors', async () => {
      fetchMock.mockImplementation(async () => mockErrorResponse(500));
      const ok = await helper.updateReviewComment(555, 'fresh body');
      expect(ok).toBe(false);
    });
  });

  describe('postReview updateInPlace', () => {
    it('PATCHes the matched thread instead of re-posting', async () => {
      const fp = fingerprintForIssue({
        file: 'src/b.ts',
        line: 42,
        severity: 'critical',
        message: 'Bug.',
        suggestion: 'Fix it.',
      });
      const calls: Array<{ url: string; method?: string; body?: string }> = [];
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        calls.push({ url, method: options?.method, body: String(options?.body ?? '') });
        if (isDiffFetch(url)) return mockResponse({ text: vi.fn().mockResolvedValue(DIFF_TEXT) });
        if (url.includes('/pulls/comments/')) return mockResponse({ body: {} });
        if (url.includes('/pulls/42/reviews')) return mockResponse({ body: { id: 7 } });
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult(), true, undefined, {
        updateInPlace: true,
        previousFingerprintCommentIds: { [fp]: 555 },
      });

      expect(result.success).toBe(true);
      expect(result.updatedInlineCount).toBe(1);
      // One PATCH, one body-only review POST, and no duplicate inline POST.
      expect(calls.filter((c) => c.method === 'PATCH').length).toBe(1);
      expect(calls.filter((c) => c.url.includes('/pulls/42/comments'))).toHaveLength(0);
      expect(calls.filter((c) => c.url.includes('/pulls/42/reviews'))).toHaveLength(1);
    });

    it('falls back to create when the PATCH fails', async () => {
      const fp = fingerprintForIssue({
        file: 'src/b.ts',
        line: 42,
        severity: 'critical',
        message: 'Bug.',
        suggestion: 'Fix it.',
      });
      fetchMock.mockImplementation(async (url: string, _options?: RequestInit) => {
        if (isDiffFetch(url)) return mockResponse({ text: vi.fn().mockResolvedValue(DIFF_TEXT) });
        if (url.includes('/pulls/comments/')) return mockErrorResponse(500);
        if (url.includes('/pulls/42/reviews')) {
          return mockResponse({
            body: { id: 1, comments: [{ id: 100, path: 'src/b.ts', line: 42 }] },
          });
        }
        if (url.includes('/pulls/42/comments')) return mockResponse({ body: { id: 2 } });
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult(), true, undefined, {
        updateInPlace: true,
        previousFingerprintCommentIds: { [fp]: 555 },
      });

      expect(result.success).toBe(true);
      expect(result.updatedInlineCount).toBeUndefined();
      expect(result.commentIds).toHaveLength(1);
    });

    it('falls back to dedup (no PATCH) without a fingerprint map', async () => {
      const fp = fingerprintForIssue({
        file: 'src/b.ts',
        line: 42,
        severity: 'critical',
        message: 'Bug.',
        suggestion: 'Fix it.',
      });
      const calls: Array<{ url: string; method?: string }> = [];
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        calls.push({ url, method: options?.method });
        if (isDiffFetch(url)) return mockResponse({ text: vi.fn().mockResolvedValue(DIFF_TEXT) });
        if (url.includes('/pulls/42/reviews')) return mockResponse({ body: { id: 7 } });
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult(), true, undefined, {
        updateInPlace: true,
        previousFingerprints: new Set([fp]),
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe('body-only');
      expect(result.updatedInlineCount).toBeUndefined();
      expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    });
  });

  describe('postReview emitChecksSummary', () => {
    it('emits one Checks run with deterministic counts', async () => {
      const calls: Array<{ url: string; method?: string; body?: string }> = [];
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        calls.push({ url, method: options?.method, body: String(options?.body ?? '') });
        if (isDiffFetch(url)) return mockResponse({ text: vi.fn().mockResolvedValue(DIFF_TEXT) });
        if (url.includes('/pulls/42/reviews')) {
          return mockResponse({
            body: { id: 1, comments: [{ id: 100, path: 'src/b.ts', line: 42 }] },
          });
        }
        if (url.includes('/pulls/42/comments')) return mockResponse({ body: { id: 2 } });
        if (url.includes('/check-runs')) return mockResponse({ body: { id: 99 } });
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult(), true, undefined, {
        emitChecksSummary: true,
      });

      expect(result.success).toBe(true);
      expect(result.checksRunId).toBe(99);
      const checkCalls = calls.filter((c) => c.url.includes('/check-runs'));
      expect(checkCalls).toHaveLength(1);
      expect(checkCalls[0]?.body).toContain('"conclusion":"failure"');
      expect(checkCalls[0]?.body).toContain('1 critical');
    });

    it('fails open when the Checks API errors', async () => {
      fetchMock.mockImplementation(async (url: string, _options?: RequestInit) => {
        if (isDiffFetch(url)) return mockResponse({ text: vi.fn().mockResolvedValue(DIFF_TEXT) });
        if (url.includes('/pulls/42/reviews')) {
          return mockResponse({
            body: { id: 1, comments: [{ id: 100, path: 'src/b.ts', line: 42 }] },
          });
        }
        if (url.includes('/check-runs')) return mockErrorResponse(403, 'Forbidden');
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult(), true, undefined, {
        emitChecksSummary: true,
      });

      expect(result.success).toBe(true);
      expect(result.checksRunId).toBeUndefined();
    });

    it('makes no Checks call when the flag is absent (legacy)', async () => {
      const calls: string[] = [];
      fetchMock.mockImplementation(async (url: string, _options?: RequestInit) => {
        calls.push(url);
        if (isDiffFetch(url)) return mockResponse({ text: vi.fn().mockResolvedValue(DIFF_TEXT) });
        if (url.includes('/pulls/42/reviews')) {
          return mockResponse({
            body: { id: 1, comments: [{ id: 100, path: 'src/b.ts', line: 42 }] },
          });
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult());
      expect(result.success).toBe(true);
      expect(calls.filter((u) => u.includes('/check-runs'))).toHaveLength(0);
    });
  });

  describe('config plumbing', () => {
    it('defaults both flags to false', () => {
      expect(DEFAULT_CONFIG.review.updateInPlace).toBe(false);
      expect(DEFAULT_CONFIG.review.emitChecksSummary).toBe(false);
    });

    it('validateConfig passes the flags through', () => {
      const out = validateConfig({ review: { updateInPlace: true, emitChecksSummary: true } });
      expect(out.review?.updateInPlace).toBe(true);
      expect(out.review?.emitChecksSummary).toBe(true);
    });
  });
});
