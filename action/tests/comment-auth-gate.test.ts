import type { PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs } from './helpers/mock-factories.js';

const {
  mockGetInput,
  mockSetFailed,
  mockSetOutput,
  mockInfo,
  mockContext,
  mockGatherContext,
  mockEngineAnalyze,
  mockEngineDocs,
  mockPostOrUpdateComment,
  mockGetMR,
  mockIsMR,
} = vi.hoisted(() => ({
  mockGetInput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockSetOutput: vi.fn(),
  mockInfo: vi.fn(),
  mockContext: {
    eventName: undefined as string | undefined,
    actor: 'workflow-actor',
    payload: {} as Record<string, unknown>,
    repo: { owner: 'o', repo: 'r' },
  },
  mockGatherContext: vi.fn(),
  mockEngineAnalyze: vi.fn(),
  mockEngineDocs: vi.fn(),
  mockPostOrUpdateComment: vi.fn(),
  mockGetMR: vi.fn(),
  mockIsMR: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setFailed: mockSetFailed,
  setOutput: mockSetOutput,
  info: mockInfo,
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  saveState: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: mockContext,
}));

import { runAnalyze } from '../src/analyze.js';
import { runDocs } from '../src/docs.js';

const mockEngine = {
  runAnalyze: mockEngineAnalyze,
  runDocs: mockEngineDocs,
} as unknown as ReviewEngine;

const mockGh = {
  gatherContext: mockGatherContext,
  postOrUpdateComment: mockPostOrUpdateComment,
  getMR: mockGetMR,
  isMR: mockIsMR,
  ensureLabels: vi.fn(),
  addLabels: vi.fn(),
} as unknown as PlatformAdapter;

describe('in-mode fail-closed comment-trigger preconditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInput.mockReturnValue('');
    mockContext.eventName = undefined;
    mockContext.actor = 'workflow-actor';
    mockContext.payload = {};
  });

  it('runAnalyze refuses a stray non-command comment before any engine work', async () => {
    mockContext.eventName = 'issue_comment';
    mockContext.payload = {
      issue: { number: 42 },
      comment: { body: 'looks good, thanks!', user: { login: 'mallory' } },
    };

    await runAnalyze(makeInputs(), makeConfig(), mockEngine, mockGh, 'o/r', 'token');

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Refusing comment trigger'));
    expect(mockGatherContext).not.toHaveBeenCalled();
    expect(mockEngineAnalyze).not.toHaveBeenCalled();
  });

  it('runAnalyze still runs for a recognized /analyze command', async () => {
    mockContext.eventName = 'issue_comment';
    mockContext.payload = {
      issue: { number: 42 },
      comment: { body: '/analyze please', user: { login: 'alice' } },
    };
    mockGatherContext.mockResolvedValue('## context');
    mockEngineAnalyze.mockResolvedValue('## Plan');

    await runAnalyze(makeInputs(), makeConfig(), mockEngine, mockGh, 'o/r', 'token');

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockGatherContext).toHaveBeenCalled();
  });

  it('runAnalyze still runs on non-comment events (label/schedule flows)', async () => {
    mockContext.eventName = 'issues';
    mockContext.payload = { issue: { number: 42 } };
    mockGatherContext.mockResolvedValue('## context');
    mockEngineAnalyze.mockResolvedValue('## Plan');

    await runAnalyze(makeInputs(), makeConfig(), mockEngine, mockGh, 'o/r', 'token');

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockGatherContext).toHaveBeenCalled();
  });

  it('runDocs refuses a stray non-command comment before resolving the PR', async () => {
    mockContext.eventName = 'issue_comment';
    mockContext.payload = {
      issue: { number: 7 },
      comment: { body: 'random chatter', user: { login: 'mallory' } },
    };

    await runDocs(makeInputs(), makeConfig(), mockEngine, mockGh);

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Refusing comment trigger'));
    expect(mockIsMR).not.toHaveBeenCalled();
    expect(mockEngineDocs).not.toHaveBeenCalled();
  });

  it('runDocs still runs for a recognized /docs command', async () => {
    mockContext.eventName = 'issue_comment';
    mockContext.payload = {
      issue: { number: 7 },
      comment: { body: '/docs please', user: { login: 'alice' } },
    };
    mockIsMR.mockResolvedValue(true);
    mockGetMR.mockResolvedValue({
      number: 7,
      headRef: 'feature',
      headSha: 'abc',
      labels: [],
      author: 'alice',
    });
    mockGatherContext.mockResolvedValue('## context');
    mockEngineDocs.mockResolvedValue({ changesMade: false });

    await runDocs(
      makeInputs(),
      makeConfig({ docs: { enabled: true, style: 'auto' } }),
      mockEngine,
      mockGh,
    );

    expect(mockSetFailed).not.toHaveBeenCalledWith(
      expect.stringContaining('Refusing comment trigger'),
    );
    expect(mockIsMR).toHaveBeenCalled();
  });
});
