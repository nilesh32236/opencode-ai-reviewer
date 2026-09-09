import type { AgentConfig, EventBus, PlatformAdapter } from '@opencode-pr-agent/lib';
import { logger } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDocsCommand } from '../../src/handlers/commands';
import * as execGitModule from '../../src/utils/git';

vi.mock('../../src/utils/git.js', () => ({
  execGit: vi.fn(),
}));

// mock logger.error to check for error
vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...mod,
    logger: {
      ...mod.logger,
      error: vi.fn(),
    },
  };
});

describe('handleDocsCommand with invalid refs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject invalid defaultBranch before making sensitive checkout/rebase calls', async () => {
    const gh = {
      getDefaultBranch: vi.fn().mockResolvedValue('--upload-pack=touch'),
      getMR: vi
        .fn()
        .mockResolvedValue({
          headRef: null,
          baseRef: '--upload-pack=touch',
          headRepoFullName: 'owner/repo',
        }),
      getIssue: vi.fn().mockResolvedValue({ title: 'foo', body: 'bar' }),
      gatherContext: vi.fn().mockResolvedValue(''),
      postOrUpdateComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformAdapter;

    const config = { docs: { enabled: true } } as unknown as AgentConfig;
    const eventBus = { emit: vi.fn() } as unknown as EventBus;

    await handleDocsCommand(
      gh,
      123,
      'owner/repo',
      config,
      '/tmp',
      undefined,
      undefined,
      eventBus,
      '1',
    );

    // The handler does initial clone setup fetches before fetching the invalid ref
    // We want to assert that it NEVER checks out the malicious ref
    expect(execGitModule.execGit).not.toHaveBeenCalledWith(
      ['checkout', '-b', expect.anything(), 'origin/--upload-pack=touch'],
      expect.anything(),
    );
    // or rebasing
    expect(execGitModule.execGit).not.toHaveBeenCalledWith(
      ['pull', '--rebase', expect.anything(), '--upload-pack=touch'],
      expect.anything(),
    );

    // It should hit the validation and stop, posting an error
    expect(gh.postOrUpdateComment).toHaveBeenCalledWith(
      123,
      '<!-- docs-error -->',
      expect.stringContaining('Ref name must not begin with a dash'),
    );
  });
});
