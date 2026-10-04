import type { GitHubHelper, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs, makePRContext } from './helpers/mock-factories.js';

const {
  mockGetInput,
  mockSetOutput,
  mockSetFailed,
  mockInfo,
  mockWarning,
  mockGetMR,
  mockUpdateMR,
  mockPostOrUpdateComment,
  mockRunDescribe,
} = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  const _mockSetOutput = vi.fn();
  const _mockSetFailed = vi.fn();
  const _mockInfo = vi.fn();
  const _mockWarning = vi.fn();
  const _mockGetMR = vi.fn();
  const _mockUpdateMR = vi.fn();
  const _mockPostOrUpdateComment = vi.fn();
  const _mockRunDescribe = vi.fn();
  return {
    mockGetInput: _mockGetInput,
    mockSetOutput: _mockSetOutput,
    mockSetFailed: _mockSetFailed,
    mockInfo: _mockInfo,
    mockWarning: _mockWarning,
    mockGetMR: _mockGetMR,
    mockUpdateMR: _mockUpdateMR,
    mockPostOrUpdateComment: _mockPostOrUpdateComment,
    mockRunDescribe: _mockRunDescribe,
  };
});

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
}));

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'pull_request',
    payload: { pull_request: { number: 7 } },
    repo: { owner: 'owner', repo: 'repo' },
  },
}));

import { runDescribe } from '../src/describe.js';

const mockGh = {
  getMR: mockGetMR,
  updateMR: mockUpdateMR,
  postOrUpdateComment: mockPostOrUpdateComment,
} as unknown as PlatformAdapter & GitHubHelper;

const mockEngine = { runDescribe: mockRunDescribe } as unknown as ReviewEngine;

// A credential the describe engine would quote straight out of the diff.
const ANTHROPIC_KEY = 'sk-ant-api03secretkeyvalue1234567890abcdefghijkl';
const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const LEAKED_DESCRIPTION = `## Summary\nAdds a client that authenticates with ${ANTHROPIC_KEY} and CI uses ${GITHUB_TOKEN}.`;

describe('runDescribe secret redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInput.mockImplementation(() => '');
    mockGetMR.mockResolvedValue(makePRContext({ number: 7 }));
    mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    mockUpdateMR.mockResolvedValue(undefined);
    mockRunDescribe.mockResolvedValue(LEAKED_DESCRIPTION);
  });

  function commentBody(): string {
    expect(mockPostOrUpdateComment).toHaveBeenCalled();
    return String(mockPostOrUpdateComment.mock.calls[0][2]);
  }

  it('redacts credentials from the generated description before any sink sees it', async () => {
    await runDescribe(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
    );

    // The description is derived from the diff, so it can quote a hardcoded
    // credential verbatim. `sanitizeMarkdown` escapes markup but never
    // redacts, so redaction has to happen at the source.
    const body = commentBody();
    expect(body).not.toContain(ANTHROPIC_KEY);
    expect(body).not.toContain(GITHUB_TOKEN);
    expect(body).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(body).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('redacts the `description` step output too', async () => {
    await runDescribe(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
    );

    expect(mockSetOutput).toHaveBeenCalledWith(
      'description',
      expect.not.stringContaining(ANTHROPIC_KEY),
    );
    const [, output] = mockSetOutput.mock.calls.find((c) => c[0] === 'description') as [
      string,
      string,
    ];
    expect(output).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('redacts the PR-body marker merge', async () => {
    const config = makeConfig({
      enableMCP: false,
      mcpServers: [],
      describe: { publishAsComment: false, useMarkers: true },
    });

    await runDescribe(makeInputs(), config, mockEngine, mockGh, 'owner/repo', 'token');

    expect(mockUpdateMR).toHaveBeenCalledTimes(1);
    const [, patch] = mockUpdateMR.mock.calls[0] as [number, { body: string }];
    expect(patch.body).not.toContain(ANTHROPIC_KEY);
    expect(patch.body).not.toContain(GITHUB_TOKEN);
    expect(patch.body).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('does not fail the run when both outputs succeed', async () => {
    await runDescribe(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
    );

    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});
