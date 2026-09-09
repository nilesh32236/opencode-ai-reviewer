import type { AgentConfig } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/handlers/commands';
import * as execGitModule from '../../src/utils/git';

vi.mock('../../src/utils/git.js', () => ({
  execGit: vi.fn(),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  class MockGitHubHelper {
    getDefaultBranch = vi.fn().mockResolvedValue('--upload-pack=touch');
    getMR = vi.fn().mockResolvedValue({
      headRef: null,
      baseRef: '--upload-pack=touch',
      headRepoFullName: 'owner/repo',
    });
    getIssue = vi.fn().mockResolvedValue({ title: 'foo', body: 'bar' });
    gatherContext = vi.fn().mockResolvedValue('');
    postOrUpdateComment = vi.fn().mockResolvedValue(undefined);
    ensureLabels = vi.fn().mockResolvedValue(undefined);
    getIssueComments = vi.fn().mockResolvedValue([]);
  }
  return {
    ...mod,
    GitHubHelper: MockGitHubHelper,
  };
});

describe('handleCommand(fix) with invalid refs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject invalid defaultBranch before git clone/exec', async () => {
    const config = {
      agent: { provider: 'dummy', model: 'dummy' },
      docs: { enabled: true },
    } as unknown as AgentConfig;

    await handleCommand(
      'fix',
      123,
      'owner/repo',
      'token',
      config,
      undefined,
      undefined,
      undefined,
      '1',
    );

    expect(execGitModule.execGit).not.toHaveBeenCalledWith(
      ['checkout', '-b', expect.anything(), 'origin/--upload-pack=touch'],
      expect.anything(),
    );
  });
});
