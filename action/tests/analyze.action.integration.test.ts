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
  ensureLabels: vi.fn(),
  addLabels: vi.fn(),
} as unknown as PlatformAdapter;

describe('runAnalyze (action wrapper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInput.mockReturnValue('');
    mockGatherContext.mockResolvedValue('## Issue Context\nSome details');
  });

  it('posts a generic public comment so secret-bearing errors never reach the issue', async () => {
    const secret = 'sk-ant-api03secretkeyvalue1234567890abcdefghijkl';
    mockRunAnalyze.mockRejectedValue(new Error(`LLM request failed: ${secret}`));

    await runAnalyze(makeInputs(), makeConfig(), mockEngine, mockGh, 'owner/repo', 'token');

    // Public comment is generic: no internal error text and no secret.
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- issue-analysis-error -->',
      expect.stringContaining('See the action logs for details'),
    );
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- issue-analysis-error -->',
      expect.not.stringContaining(secret),
    );
    // The failure signal is generic too, so secrets stay in the logs only.
    expect(mockSetFailed).toHaveBeenCalledWith(expect.not.stringContaining(secret));
  });

  it('never posts bearer tokens to the issue comment on failure', async () => {
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
      expect.stringContaining('See the action logs for details'),
    );
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- issue-analysis-error -->',
      expect.not.stringContaining(bearer),
    );
    expect(mockSetFailed).toHaveBeenCalledWith(expect.not.stringContaining(bearer));
  });

  it('sanitizes prompt-injected markdown in the posted analysis plan', async () => {
    const hostile =
      'Plan looks good ![tracker](https://exfil.example/pixel.png) ' +
      '<img src="x" onerror="alert(1)"> <!-- issue-analysis-plan --> ' +
      '[click me](javascript:alert(1))';
    mockRunAnalyze.mockResolvedValue(`## Plan\n\n${hostile}`);

    await runAnalyze(makeInputs(), makeConfig(), mockEngine, mockGh, 'owner/repo', 'token');

    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- issue-analysis-plan -->',
      expect.not.stringContaining('![tracker]'),
    );
    const [, , body] = mockPostOrUpdateComment.mock.calls.find(
      (call) => (call as unknown[])[1] === '<!-- issue-analysis-plan -->',
    ) as unknown as [number, string, string];
    expect(body).not.toContain('<img');
    expect(body).not.toContain('<!-- issue-analysis-plan -->');
    expect(body).not.toContain('](javascript:');
  });
});
