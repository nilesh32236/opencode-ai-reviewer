import type { AgentConfig, ReviewResult } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAudit } from '../src/handlers/audit.js';

const { ghMock, engineMock, libMocks, fsMocks } = vi.hoisted(() => {
  const ghMock = {
    ensureLabels: vi.fn(),
    postOrUpdateComment: vi.fn(),
    createIssue: vi.fn(),
  };
  const engineMock = {
    runAudit: vi.fn(),
    cleanup: vi.fn(),
  };
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
  const fsMocks = {
    existsSync: vi.fn(() => true),
    readdir: vi.fn(async () => ['security-privacy.md']),
    access: vi.fn(async () => undefined),
    readFile: vi.fn(async () => '# Audit prompt'),
  };
  return { ghMock, engineMock, libMocks, fsMocks };
});

vi.mock('@opencode-pr-agent/lib', () => libMocks);
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    promises: {
      ...actual.promises,
      readdir: fsMocks.readdir,
      access: fsMocks.access,
      readFile: fsMocks.readFile,
    },
  };
});

const AUDIT_ERROR_MARKER = '<!-- audit-error -->';

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

function buildEmptyResult(): ReviewResult {
  return {
    summary: '',
    verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
  };
}

describe('handleAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ghMock.ensureLabels.mockResolvedValue(undefined);
    ghMock.postOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    ghMock.createIssue.mockResolvedValue({ number: 7, url: 'https://example.com/7' });
    engineMock.runAudit.mockResolvedValue(buildEmptyResult());
    engineMock.cleanup.mockResolvedValue(undefined);
  });

  it('does not post an audit-error comment when no issueNumber is known', async () => {
    engineMock.runAudit.mockRejectedValue(new Error('engine boom'));

    await handleAudit('owner/repo', 'token', buildConfig());

    expect(ghMock.postOrUpdateComment).not.toHaveBeenCalled();
    expect(ghMock.createIssue).not.toHaveBeenCalled();
  });

  it('posts a sanitized audit-error comment when issueNumber is provided', async () => {
    engineMock.runAudit.mockRejectedValue(new Error('engine boom'));

    await handleAudit(
      'owner/repo',
      'token',
      buildConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      42,
    );

    expect(ghMock.postOrUpdateComment).toHaveBeenCalledTimes(1);
    expect(ghMock.postOrUpdateComment).toHaveBeenCalledWith(
      42,
      AUDIT_ERROR_MARKER,
      expect.stringContaining('❌ **Audit failed.**'),
    );
    const body = String(vi.mocked(ghMock.postOrUpdateComment).mock.calls[0][2]);
    expect(body).toContain('engine boom');
    expect(body).not.toContain('at ');
    expect(libMocks.sanitizeErrorMessage).toHaveBeenCalled();
  });

  it('posts an audit-error comment on empty audit results when issueNumber is provided', async () => {
    engineMock.runAudit.mockResolvedValue(buildEmptyResult());

    await handleAudit(
      'owner/repo',
      'token',
      buildConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      42,
    );

    expect(ghMock.createIssue).not.toHaveBeenCalled();
    expect(ghMock.postOrUpdateComment).toHaveBeenCalledTimes(1);
    const body = String(vi.mocked(ghMock.postOrUpdateComment).mock.calls[0][2]);
    expect(body).toContain('❌ **Audit failed.**');
    expect(body).toContain('no meaningful content');
  });

  it('does not post an audit-error comment for empty results when no issueNumber is known', async () => {
    engineMock.runAudit.mockResolvedValue(buildEmptyResult());

    await handleAudit('owner/repo', 'token', buildConfig());

    expect(ghMock.postOrUpdateComment).not.toHaveBeenCalled();
    expect(ghMock.createIssue).not.toHaveBeenCalled();
  });
});
