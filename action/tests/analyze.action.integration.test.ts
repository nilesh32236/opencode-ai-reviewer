import type { PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs } from './helpers/mock-factories.js';

const {
  mockGetInput,
  mockSetFailed,
  mockSetOutput,
  mockGatherContext,
  mockRunAnalyze,
  mockPostOrUpdateComment,
} = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  const _mockSetFailed = vi.fn();
  const _mockSetOutput = vi.fn();
  const _mockGatherContext = vi.fn();
  const _mockRunAnalyze = vi.fn();
  const _mockPostOrUpdateComment = vi.fn();
  return {
    mockGetInput: _mockGetInput,
    mockSetFailed: _mockSetFailed,
    mockSetOutput: _mockSetOutput,
    mockGatherContext: _mockGatherContext,
    mockRunAnalyze: _mockRunAnalyze,
    mockPostOrUpdateComment: _mockPostOrUpdateComment,
  };
});

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setFailed: mockSetFailed,
  setOutput: mockSetOutput,
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: {
    payload: {
      issue: { number: 42 },
    },
    repo: { owner: 'owner', repo: 'repo' },
  },
}));

import { runAnalyze } from '../src/analyze.js';

const mockEngine = {
  runAnalyze: mockRunAnalyze,
} as unknown as ReviewEngine;

const mockGh = {
  gatherContext: mockGatherContext,
  postOrUpdateComment: mockPostOrUpdateComment,
} as unknown as PlatformAdapter;

describe('runAnalyze (action wrapper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInput.mockReturnValue('');
    mockGatherContext.mockResolvedValue('## Issue Context\nSome details');
  });

  it('sanitizes secret-bearing error messages before posting to the public issue comment', async () => {
    const secret = 'sk-ant-api03secretkeyvalue1234567890abcdefghijkl';
    mockRunAnalyze.mockRejectedValue(new Error(`LLM request failed: ${secret}`));

    await runAnalyze(makeInputs(), makeConfig(), mockEngine, mockGh, 'owner/repo', 'token');

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('[REDACTED_ANTHROPIC_KEY]'));
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- issue-analysis-error -->',
      expect.stringContaining('[REDACTED_ANTHROPIC_KEY]'),
    );
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- issue-analysis-error -->',
      expect.not.stringContaining(secret),
    );
  });

  it('redacts bearer tokens in error messages posted to the issue comment', async () => {
    // Keep the three JWT segments as separate literals and join them at runtime
    // so secret scanners do not flag the fixture as a real token.
    const jwtHeader = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const jwtPayload = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const jwtSignature = 'dGVzdHNpZ25hdHVyZQ';
    const bearer = `${jwtHeader}.${jwtPayload}.${jwtSignature}`;
    mockRunAnalyze.mockRejectedValue(new Error(`Unauthorized: Bearer ${bearer}`));

    await runAnalyze(makeInputs(), makeConfig(), mockEngine, mockGh, 'owner/repo', 'token');

    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- issue-analysis-error -->',
      expect.stringContaining('[REDACTED]'),
    );
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- issue-analysis-error -->',
      expect.not.stringContaining(bearer),
    );
  });
});
