import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentConfig } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/handlers/commands.js';

const { mockExecFileSync, mockIsMR, mockGetMR, mockRunDescribe, mockPostOrUpdateComment } =
  vi.hoisted(() => {
    const _mockExecFileSync = vi.fn();
    const _mockIsMR = vi.fn();
    const _mockGetMR = vi.fn();
    const _mockRunDescribe = vi.fn();
    const _mockPostOrUpdateComment = vi.fn();
    return {
      mockExecFileSync: _mockExecFileSync,
      mockIsMR: _mockIsMR,
      mockGetMR: _mockGetMR,
      mockRunDescribe: _mockRunDescribe,
      mockPostOrUpdateComment: _mockPostOrUpdateComment,
    };
  });

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    ReviewEngine: class {
      runDescribe = mockRunDescribe;
      cleanup = vi.fn();
    },
    GitHubHelper: class {
      isMR = mockIsMR;
      getMR = mockGetMR;
      postOrUpdateComment = mockPostOrUpdateComment;
    },
    GitLabAdapter: class {
      isMR = mockIsMR;
      getMR = mockGetMR;
      postOrUpdateComment = mockPostOrUpdateComment;
    },
  };
});

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    platform: 'github',
    describe: { enabled: true },
    ...overrides,
  } as AgentConfig;
}

describe('handleCommand /describe', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-describe-cmd-'));
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue(Buffer.alloc(0));
    mockIsMR.mockResolvedValue(true);
    mockGetMR.mockResolvedValue({
      number: 42,
      title: 'Test PR',
      body: 'Body',
      headRef: 'feature',
      headSha: 'abc123',
      baseRef: 'main',
      author: 'test-user',
      labels: [],
      changedFiles: [],
    });
    mockRunDescribe.mockResolvedValue('Generated description');
    mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('clones from the GitHub remote for github platform', async () => {
    const ghArgs: string[][] = [];
    mockExecFileSync.mockImplementation((_p: string, args: string[]) => {
      if (args[0] === 'clone') ghArgs.push(args);
      return Buffer.alloc(0);
    });

    await handleCommand('describe', 42, 'owner/repo', 'token', makeConfig());

    expect(ghArgs).toHaveLength(1);
    expect(ghArgs[0][1]).toBe('https://github.com/owner/repo.git');
    expect(mockRunDescribe).toHaveBeenCalledTimes(1);
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- pr-description -->',
      'Generated description',
    );
  });

  it('clones from the GitLab remote URL for gitlab platform', async () => {
    const cloneRemoteCalls: string[] = [];
    mockExecFileSync.mockImplementation((_p: string, args: string[]) => {
      if (args[0] === 'clone') cloneRemoteCalls.push(args[1]);
      return Buffer.alloc(0);
    });

    await handleCommand('describe', 42, 'owner/repo', 'token', makeConfig({ platform: 'gitlab' }));

    expect(cloneRemoteCalls).toContain('https://gitlab.com/owner/repo.git');
    expect(cloneRemoteCalls).not.toContain('https://github.com/owner/repo.git');
    expect(mockRunDescribe).toHaveBeenCalledTimes(1);
  });
});
