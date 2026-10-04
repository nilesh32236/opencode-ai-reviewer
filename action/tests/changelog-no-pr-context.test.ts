/**
 * Changelog mode used to resolve a PR number and `setFailed` when it could not
 * find one, even though the resolved value was never referenced anywhere in the
 * function: `generateChangelog` reads merged PRs since the last release tag.
 * Schedule- and dispatch-triggered release prep has no PR in context, so the
 * mode aborted for a condition attached to the wrong data.
 */
import type { AgentConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from './helpers/mock-factories.js';

const { mockSetFailed, mockInfo, mockGenerateChangelog } = vi.hoisted(() => ({
  mockSetFailed: vi.fn(),
  mockInfo: vi.fn(),
  mockGenerateChangelog: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  info: mockInfo,
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setFailed: mockSetFailed,
  setOutput: vi.fn(),
}));

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

// No PR in context (schedule / workflow_dispatch).
vi.mock('@actions/github', () => ({
  context: {
    eventName: 'schedule',
    payload: {},
    repo: { owner: 'owner', repo: 'repo' },
    ref: 'refs/heads/main',
  },
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    // `runChangelog` gates on `gh instanceof GitHubHelper`.
    GitHubHelper: class {},
    generateChangelog: mockGenerateChangelog,
  };
});

// The mocked `GitHubHelper` stub class: `runChangelog` gates on
// `gh instanceof GitHubHelper`, so the adapter must be one of these.
import { GitHubHelper } from '@opencode-pr-agent/lib';
import { runChangelog } from '../src/changelog.js';

describe('runChangelog without a pull-request context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateChangelog.mockResolvedValue({
      entryCount: 0,
      since: '2026-01-01T00:00:00.000Z',
      tag: null,
      markdown: '',
      json: '',
    });
  });

  it('does not fail the mode when no PR number can be resolved', async () => {
    const config = makeConfig({ enableMCP: false, mcpServers: [] }) as AgentConfig;
    config.changelog = { ...config.changelog, enabled: true, createPR: false };

    const gh = Object.create(GitHubHelper.prototype) as PlatformAdapter;
    await runChangelog(config, gh);

    expect(mockGenerateChangelog).toHaveBeenCalledTimes(1);
    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});
