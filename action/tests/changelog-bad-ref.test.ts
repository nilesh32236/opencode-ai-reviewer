import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { AgentConfig, GitHubHelper } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runChangelog } from '../src/changelog';

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));

vi.mock('../src/utils.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    resolvePrNumber: vi.fn().mockResolvedValue(123),
  };
});

// Mock generateChangelog to avoid making real API calls or triggering other parts of the lib
vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...mod,
    generateChangelog: vi.fn().mockResolvedValue({
      entryCount: 1,
      since: '2023-01-01',
      tag: 'v1.0.0',
      json: '',
      markdown: '',
    }),
  };
});

describe('runChangelog with invalid refs', () => {
  beforeEach(() => {
    process.env.GITHUB_EVENT_NAME = 'issue_comment';
    vi.clearAllMocks();
  });

  it('should reject invalid defaultBranch before exec', async () => {
    // Create a real instance so `instanceof GitHubHelper` passes
    const gh = new GitHubHelper('dummy', 'dummy', 'dummy', 'dummy');
    gh.getDefaultBranch = vi.fn().mockResolvedValue('--upload-pack=touch');

    const config = {
      changelog: { enabled: true, createPR: true, prBranchPrefix: 'changelog' },
    } as unknown as AgentConfig;

    await runChangelog(config, gh);

    // In runChangelog, errors are caught and core.setFailed is called instead of throwing.
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Ref name must not begin with a dash'),
    );
    expect(exec.exec).not.toHaveBeenCalled();
    expect(exec.getExecOutput).not.toHaveBeenCalled();
  });
});
