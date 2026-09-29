import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from './helpers/mock-factories.js';

const { mockGitHubHelper, mockGenerateChangelog, mockExec, mockGetExecOutput, mockSetFailed } =
  vi.hoisted(() => {
    class FakeGitHubHelper {}
    return {
      mockGitHubHelper: FakeGitHubHelper,
      mockGenerateChangelog: vi.fn(),
      mockExec: vi.fn(),
      mockGetExecOutput: vi.fn(),
      mockSetFailed: vi.fn(),
    };
  });

vi.mock('@actions/core', () => ({
  setOutput: vi.fn(),
  setFailed: mockSetFailed,
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  getInput: vi.fn().mockReturnValue('42'),
}));

vi.mock('@actions/exec', () => ({
  exec: mockExec,
  getExecOutput: mockGetExecOutput,
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return { ...mod, GitHubHelper: mockGitHubHelper, generateChangelog: mockGenerateChangelog };
});

vi.mock('../src/utils.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils.js')>();
  return { ...mod, resolvePrNumber: vi.fn().mockResolvedValue(42) };
});

import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { runChangelog } from '../src/changelog.js';

describe('runChangelog staging scope', () => {
  let workspace: string;
  let prevWorkspace: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-changelog-stage-'));
    fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), '# Changelog\n');
    // Unrelated dirty file that must NOT be swept into the release commit.
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'unrelated\n');
    prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = workspace;

    mockGenerateChangelog.mockResolvedValue({
      entryCount: 1,
      since: '2026-01-01',
      tag: 'v1.2.3',
      markdown: '## 1.2.3\n\n- feat: something\n',
      json: '{}',
    });
    // Branch does not exist yet (rev-parse exits non-zero).
    mockExec.mockResolvedValue(0);
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: 'M CHANGELOG.md', stderr: '' });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    process.env.GITHUB_WORKSPACE = prevWorkspace ?? '';
  });

  it('stages only the resolved changelog path, never the whole workspace', async () => {
    // `runChangelog` gates on `gh instanceof GitHubHelper`, so the fake adapter
    // must be an instance of the mocked class.
    const FakeHelper = mockGitHubHelper as unknown as new () => Record<string, unknown>;
    const gh = Object.assign(new FakeHelper(), {
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      ensureLabels: vi.fn().mockResolvedValue(undefined),
      createPR: vi.fn().mockResolvedValue({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
      }),
      addLabels: vi.fn().mockResolvedValue(undefined),
    }) as unknown as PlatformAdapter;

    await runChangelog(
      makeConfig({
        changelog: {
          enabled: true,
          outputFormat: 'markdown',
          categories: [],
          filePath: 'CHANGELOG.md',
          createPR: true,
          prBranchPrefix: 'changelog',
          includeFiles: false,
        },
      }),
      gh,
    );

    expect(mockSetFailed).not.toHaveBeenCalled();
    const gitAddCalls = mockExec.mock.calls.filter(
      (call) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'add',
    );
    expect(gitAddCalls).toHaveLength(1);
    const addArgs = gitAddCalls[0][1] as string[];
    // `--` terminates option parsing; the only pathspec is the changelog file.
    expect(addArgs).toEqual(['add', '--', path.join(workspace, 'CHANGELOG.md')]);
    expect(addArgs).not.toContain('-A');
  });
});
