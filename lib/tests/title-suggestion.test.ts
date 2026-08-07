import { describe, expect, it, vi } from 'vitest';
import type { ChangedFile, PRContext, ReviewResult } from '../src/types/index.js';
import {
  TITLE_SUGGESTION_MARKER,
  buildSuggestionComment,
  deriveSuggestedLabels,
  deriveSuggestedTitle,
  postSuggestionComment,
} from '../src/utils/title-suggestion.js';

function pr(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 1,
    title: 'Add rate limiting to the API',
    body: '',
    headRef: 'feature/rate-limit',
    headSha: 'sha',
    baseRef: 'main',
    author: 'user',
    labels: [],
    changedFiles: [],
    ...overrides,
  };
}

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'added', additions: 10, deletions: 0, ...overrides };
}

function result(issues: Array<{ severity: string }> = []): ReviewResult {
  return {
    summary: 's',
    verdict: { ready: true, reasoning: 'r', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues: issues.map((i, idx) => ({
      type: 'issue',
      severity: i.severity as 'critical' | 'important' | 'minor',
      file: 'a.ts',
      line: idx + 1,
      message: 'm',
    })),
    stats: { total: issues.length, critical: 0, important: 0, minor: 0 },
  };
}

describe('deriveSuggestedTitle', () => {
  it('keeps an already-conventional title unchanged', () => {
    const ctx = pr({ title: 'feat(api): add rate limiting' });
    expect(deriveSuggestedTitle(ctx)).toBe('feat(api): add rate limiting');
  });

  it('returns docs type when only markdown files change', () => {
    const ctx = pr({ changedFiles: [file('docs/guide.md'), file('README.md')] });
    expect(deriveSuggestedTitle(ctx)).toBe('docs: add rate limiting to the api');
  });

  it('returns chore type when only config files change', () => {
    const ctx = pr({
      changedFiles: [file('.github/workflows/ci.yml'), file('tsconfig.json')],
    });
    expect(deriveSuggestedTitle(ctx)).toBe('chore: add rate limiting to the api');
  });

  it('returns test type when more than half the files are tests', () => {
    const ctx = pr({
      changedFiles: [
        file('src/rate.limit.test.ts', { additions: 20, deletions: 1 }),
        file('tests/utils.test.ts', { additions: 15, deletions: 1 }),
        file('src/rate.ts', { additions: 5, deletions: 1 }),
      ],
    });
    expect(deriveSuggestedTitle(ctx)).toBe('test(src): add rate limiting to the api');
  });

  it('returns feat scope for UI files with dominant additions', () => {
    const ctx = pr({
      title: 'Create dashboard widget',
      changedFiles: [file('frontend/src/widget.tsx', { additions: 120, deletions: 5 })],
    });
    expect(deriveSuggestedTitle(ctx)).toBe('feat(frontend): create dashboard widget');
  });

  it('returns feat when code additions dominate in UI files', () => {
    const ctx = pr({
      title: 'Implement caching layer',
      changedFiles: [file('frontend/widget.tsx', { additions: 200, deletions: 10 })],
    });
    expect(deriveSuggestedTitle(ctx)).toBe('feat(frontend): implement caching layer');
  });

  it('falls back to fix type for balanced code changes (cautious default)', () => {
    const ctx = pr({
      changedFiles: [file('src/helper.ts', { additions: 20, deletions: 18 })],
    });
    expect(deriveSuggestedTitle(ctx)).toBe('fix(src): add rate limiting to the api');
  });

  it('omits scope when there is no clear majority directory', () => {
    const ctx = pr({
      title: 'Fix login bug',
      changedFiles: [
        file('api/auth.ts', { additions: 5, deletions: 3 }),
        file('web/login.ts', { additions: 5, deletions: 3 }),
      ],
    });
    expect(deriveSuggestedTitle(ctx)).toBe('fix: login bug');
  });
});

describe('deriveSuggestedLabels', () => {
  it('maps file extensions to labels', () => {
    const files = [file('src/a.ts'), file('apps/b.js'), file('docs/x.md')];
    expect(deriveSuggestedLabels(files)).toEqual(['documentation', 'javascript', 'typescript']);
  });

  it('maps directory patterns to labels', () => {
    const files = [file('frontend/components/button.tsx'), file('backend/api/server.ts')];
    const labels = deriveSuggestedLabels(files);
    expect(labels).toContain('frontend');
    expect(labels).toContain('backend');
    expect(labels).toContain('typescript');
  });

  it('maps docker and workflows', () => {
    const files = [file('Dockerfile'), file('.github/workflows/ci.yml'), file('.gitignore')];
    const labels = deriveSuggestedLabels(files);
    expect(labels).toContain('docker');
    expect(labels).toContain('ci');
    expect(labels).toContain('configuration');
  });

  it('adds testing for test dirs/files', () => {
    expect(deriveSuggestedLabels([file('tests/x.test.ts')])).toContain('testing');
    expect(deriveSuggestedLabels([file('__tests__/x.ts')])).toContain('testing');
    expect(deriveSuggestedLabels([file('tests/x.ts')])).toContain('testing');
  });

  it('adds bugfix when high-severity findings exist', () => {
    const labels = deriveSuggestedLabels([file('a.ts')], result([{ severity: 'critical' }]));
    expect(labels).toContain('bugfix');
    expect(labels).toContain('typescript');
  });

  it('adds enhancement when the review has no findings', () => {
    const labels = deriveSuggestedLabels([file('a.ts')], result([]));
    expect(labels).toContain('enhancement');
  });

  it('de-duplicates labels', () => {
    const labels = deriveSuggestedLabels([file('frontend/button.jsx'), file('frontend/input.jsx')]);
    expect(labels.filter((l) => l === 'frontend')).toHaveLength(1);
    expect(labels.filter((l) => l === 'javascript')).toHaveLength(1);
  });
});

describe('buildSuggestionComment', () => {
  it('includes the suggested title, labels, and acceptance hint', () => {
    const body = buildSuggestionComment(
      { title: 'feat(api): add rate limiting', labels: ['frontend', 'testing'] },
      42,
    );
    expect(body).toContain('feat(api): add rate limiting');
    expect(body).toContain('`frontend`');
    expect(body).toContain('`testing`');
    expect(body).toContain('/suggest-title');
    expect(body).toContain('PR #42');
  });

  it('does not include the dedup marker (added by postOrUpdateComment)', () => {
    const body = buildSuggestionComment({ title: 'fix: x', labels: [] }, 1);
    expect(body).not.toContain(TITLE_SUGGESTION_MARKER);
  });
});

describe('postSuggestionComment', () => {
  it('does nothing when disabled', async () => {
    const postOrUpdateComment = vi.fn();
    await postSuggestionComment({ postOrUpdateComment } as never, 1, pr(), result([]), {
      suggestTitleAndLabels: false,
    });
    expect(postOrUpdateComment).not.toHaveBeenCalled();
  });

  it('posts the suggestion via postOrUpdateComment with the marker', async () => {
    const postOrUpdateComment = vi.fn().mockResolvedValue({ action: 'created', commentId: 1 });
    await postSuggestionComment(
      { postOrUpdateComment } as never,
      7,
      pr({
        title: 'Add caching',
        changedFiles: [file('api/cache.ts', { additions: 100, deletions: 5 })],
      }),
      result([]),
      { suggestTitleAndLabels: true },
    );
    expect(postOrUpdateComment).toHaveBeenCalledTimes(1);
    const [issueNumber, marker, body] = postOrUpdateComment.mock.calls[0] as [
      number,
      string,
      string,
    ];
    expect(issueNumber).toBe(7);
    expect(marker).toBe(TITLE_SUGGESTION_MARKER);
    expect(body).toContain('fix(api): add caching');
  });

  it('does not throw when the adapter fails (graceful degradation)', async () => {
    const postOrUpdateComment = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      postSuggestionComment(
        { postOrUpdateComment } as never,
        1,
        pr({ changedFiles: [file('a.ts')] }),
        result([]),
        { suggestTitleAndLabels: true },
      ),
    ).resolves.toBeUndefined();
  });
});
