import type { AgentConfig, PRContext, ReviewResult } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePRReview } from '../src/handlers/pr-review.js';

const { ghMock, engineMock, autofixLoopMock, libMocks } = vi.hoisted(() => {
  const ghMock = {
    getMR: vi.fn(),
    getBotReviewThreads: vi.fn(),
    postOrUpdateComment: vi.fn(),
    postReview: vi.fn(),
  };
  const engineMock = {
    reviewPR: vi.fn(),
    cleanup: vi.fn(),
  };
  const autofixLoopMock = vi.fn();
  const loggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  function MockGitHubHelper() {
    return ghMock;
  }
  function MockGitLabAdapter() {
    return ghMock;
  }
  function MockLogger() {
    return loggerMock;
  }
  function MockReviewEngine() {
    return engineMock;
  }
  const libMocks = {
    GitHubHelper: vi.fn(MockGitHubHelper),
    GitLabAdapter: vi.fn(MockGitLabAdapter),
    Logger: vi.fn(MockLogger),
    ReviewEngine: vi.fn(MockReviewEngine),
    sanitizeErrorMessage: vi.fn((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    ),
  };
  return { ghMock, engineMock, autofixLoopMock, libMocks };
});

vi.mock('@opencode-pr-agent/lib', () => libMocks);
vi.mock('../src/handlers/autofix.js', () => ({ handleAutofixLoop: autofixLoopMock }));

const REVIEW_IN_PROGRESS_MARKER = '<!-- review-in-progress -->';

function buildConfig(): AgentConfig {
  return {
    platform: 'github',
    reviewModel: 'test-model',
    fixModel: 'test-fix-model',
    batchSize: 1,
    maxLinesPerFile: 200,
    maxIterations: 1,
    enableMCP: false,
    mcpServers: [],
    projectContext: {
      description: '',
      typecheckCommands: [],
      lintCommands: [],
    },
    review: {
      skipLabels: [],
      skipActors: [],
      inline: true,
      requireVerdict: false,
      commandTriggers: ['/review'],
      excludePatterns: [],
      enableMetaVerification: false,
      enableReachability: false,
    },
    audit: {
      promptsDir: '.audit-prompts',
      targetDirs: ['.'],
      autoFix: false,
      triggerLabel: 'autofix',
      issueSeverityThreshold: 'important',
    },
    learning: {
      enabled: false,
      feedbackSignals: [],
      metaReview: { enabled: false, interval: 0, minFindingsForReview: 0 },
      patternDiscovery: { enabled: false, minFrequency: 0, windowSize: 0 },
    },
    conversation: { mentionHandle: 'opencode-reviewer', enabled: false },
    linters: [],
  };
}

function buildPR(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 42,
    title: 'Test PR',
    body: 'Changes.',
    headRef: 'feature',
    headSha: 'abc123',
    baseRef: 'main',
    author: 'alice',
    labels: [],
    changedFiles: [],
    ...overrides,
  };
}

function buildResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'Review summary.',
    verdict: { ready: true, reasoning: 'Looks good.', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    ...overrides,
  };
}

function lastPostOrUpdateComment(): { marker: string; body: string } {
  const calls = vi.mocked(ghMock.postOrUpdateComment).mock.calls;
  const last = calls[calls.length - 1];
  return { marker: String(last?.[1]), body: String(last?.[2]) };
}

describe('handlePRReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ghMock.getMR.mockResolvedValue(buildPR());
    ghMock.getBotReviewThreads.mockResolvedValue([]);
    ghMock.postOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    ghMock.postReview.mockResolvedValue({ success: true, method: 'body-only' });
    engineMock.reviewPR.mockResolvedValue(buildResult());
    engineMock.cleanup.mockResolvedValue(undefined);
  });

  it('posts the review-in-progress marker before running the engine', async () => {
    engineMock.reviewPR.mockImplementation(async () => {
      const markerCalls = vi.mocked(ghMock.postOrUpdateComment).mock.calls;
      expect(
        markerCalls.some(([num, marker]) => num === 42 && marker === REVIEW_IN_PROGRESS_MARKER),
      ).toBe(true);
      return buildResult();
    });

    await handlePRReview(42, 'owner/repo', 'token', buildConfig());

    expect(engineMock.reviewPR).toHaveBeenCalledTimes(1);
    expect(ghMock.postOrUpdateComment).toHaveBeenCalledWith(
      42,
      REVIEW_IN_PROGRESS_MARKER,
      expect.stringContaining('⏳ **Reviewing this PR...**'),
    );
  });

  it('resolves the marker to a complete message on success', async () => {
    const result = await handlePRReview(42, 'owner/repo', 'token', buildConfig());

    expect(result).not.toBeNull();
    expect(ghMock.postReview).toHaveBeenCalledTimes(1);
    const { marker, body } = lastPostOrUpdateComment();
    expect(marker).toBe(REVIEW_IN_PROGRESS_MARKER);
    expect(body).toContain('✅ **Review complete**');
  });

  it('resolves the marker to a neutral completion message on empty result', async () => {
    engineMock.reviewPR.mockResolvedValue(
      buildResult({
        summary: '',
        verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' },
      }),
    );

    const result = await handlePRReview(42, 'owner/repo', 'token', buildConfig());

    expect(result).toBeNull();
    expect(ghMock.postReview).not.toHaveBeenCalled();
    const { marker, body } = lastPostOrUpdateComment();
    expect(marker).toBe(REVIEW_IN_PROGRESS_MARKER);
    expect(body).toContain('✅ **Review complete**');
    expect(body).toContain('no findings to report');
  });

  it('replaces the marker with a failure message when postReview returns success:false', async () => {
    ghMock.postReview.mockResolvedValue({ success: false, method: 'failed' });

    const result = await handlePRReview(42, 'owner/repo', 'token', buildConfig());

    expect(result).not.toBeNull();
    const { marker, body } = lastPostOrUpdateComment();
    expect(marker).toBe(REVIEW_IN_PROGRESS_MARKER);
    expect(body).toContain('❌ **Review failed.**');
    expect(body).toContain('Could not post the review to the platform.');
  });

  it('replaces the marker with a sanitized failure message when the engine throws', async () => {
    engineMock.reviewPR.mockRejectedValue(new Error('engine boom'));

    const result = await handlePRReview(42, 'owner/repo', 'token', buildConfig());

    expect(result).toBeNull();
    const { marker, body } = lastPostOrUpdateComment();
    expect(marker).toBe(REVIEW_IN_PROGRESS_MARKER);
    expect(body).toContain('❌ **Review failed.**');
    expect(body).toContain('engine boom');
    expect(libMocks.sanitizeErrorMessage).toHaveBeenCalled();
  });

  it('replaces the marker with a failure message when postReview throws', async () => {
    ghMock.postReview.mockRejectedValue(new Error('review post boom'));

    const result = await handlePRReview(42, 'owner/repo', 'token', buildConfig());

    expect(result).toBeNull();
    const { marker, body } = lastPostOrUpdateComment();
    expect(marker).toBe(REVIEW_IN_PROGRESS_MARKER);
    expect(body).toContain('❌ **Review failed.**');
    expect(body).toContain('review post boom');
  });
});
