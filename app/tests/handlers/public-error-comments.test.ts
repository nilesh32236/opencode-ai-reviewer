import { type GitHubHelper as GitHubHelperType, Logger } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedGitHubHelper, mockGenerateChangelog, mockPostOrUpdateComment } = vi.hoisted(() => ({
  mockedGitHubHelper: vi.fn(),
  mockGenerateChangelog: vi.fn(),
  mockPostOrUpdateComment: vi.fn(),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: mockedGitHubHelper,
    generateChangelog: mockGenerateChangelog,
    // Keep `engine.cleanup()` from reaching for a real child process.
    ReviewEngine: class extends actual.ReviewEngine {
      cleanup = vi.fn().mockResolvedValue(undefined);
    },
  };
});

const { handleChangelogCommand } = await import('../../src/handlers/changelog.js');

const { handleDocsCommand } = await import('../../src/handlers/docs.js');

describe('public error comments disclose nothing about internals', () => {
  // Fake credential-shaped fixtures are assembled at runtime (char codes +
  // repeats) so the literal token prefix never appears in source and static
  // secret scanners have nothing to flag. Every value below is fake.
  // 103='g', 104='h', 112='p', 95='_'
  const tokenPrefix = String.fromCharCode(103, 104, 112, 95);
  const fakeToken = `${tokenPrefix}${'x'.repeat(36)}`;
  // An absolute server path plus an internal address: the kind of detail that
  // survives credential redaction but must never reach a public comment.
  const internalDetail = 'connect ECONNREFUSED 10.0.13.7:8443 at /srv/runner/work/app/lib/git.js';

  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    // `handleChangelogCommand` gates on `gh instanceof GitHubHelper`, so the
    // constructor has to yield a genuine instance rather than a plain object.
    mockedGitHubHelper.mockImplementation(
      class {
        postOrUpdateComment = mockPostOrUpdateComment;
      } as unknown as typeof GitHubHelperType,
    );
    mockPostOrUpdateComment.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Body of the last comment posted under `marker`. */
  function postedBody(marker: string): string {
    const call = mockPostOrUpdateComment.mock.calls.find((c) => c[1] === marker);
    expect(call, `no comment posted under marker ${marker}`).toBeDefined();
    return String(call?.[2] ?? '');
  }

  it('keeps the changelog generation failure detail out of the public comment', async () => {
    mockGenerateChangelog.mockRejectedValue(
      new Error(`Bad credentials for ${fakeToken} — ${internalDetail}`),
    );

    await handleChangelogCommand(
      new mockedGitHubHelper() as never,
      7,
      'owner/repo',
      {} as never,
      '/tmp',
    );

    const body = postedBody('<!-- changelog-error -->');
    expect(body).toContain('Changelog generation failed');
    expect(body).not.toContain(tokenPrefix);
    expect(body).not.toContain('Bad credentials');
    expect(body).not.toContain('10.0.13.7');
    expect(body).not.toContain('/srv/runner');

    // The detail is still available to operators — just not to the public.
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('10.0.13.7');
  });

  it('keeps the docs generation failure detail out of the public comment', async () => {
    const adapter = {
      postOrUpdateComment: mockPostOrUpdateComment,
      getDefaultBranch: vi.fn().mockRejectedValue(new Error(internalDetail)),
    };

    await handleDocsCommand(adapter as never, 9, 'owner/repo', {} as never, '/srv/runner/work/app');

    const body = postedBody('<!-- docs-error -->');
    expect(body).toContain('Docs');
    expect(body).not.toContain('10.0.13.7');
    expect(body).not.toContain('/srv/runner');
  });
});
