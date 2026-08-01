import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs } from './helpers/mock-factories.js';

const {
  mockGetInput,
  mockSetFailed,
  mockSetOutput,
  mockInfo,
  mockWarning,
  mockError,
  mockEnsureLabels,
  mockPaginate,
  mockRunAudit,
  mockCreateIssue,
  mockPostOrUpdateComment,
} = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  const _mockSetFailed = vi.fn();
  const _mockSetOutput = vi.fn();
  const _mockInfo = vi.fn();
  const _mockWarning = vi.fn();
  const _mockError = vi.fn();
  const _mockEnsureLabels = vi.fn();
  const _mockPaginate = vi.fn();
  const _mockRunAudit = vi.fn();
  const _mockCreateIssue = vi.fn();
  const _mockPostOrUpdateComment = vi.fn();
  return {
    mockGetInput: _mockGetInput,
    mockSetFailed: _mockSetFailed,
    mockSetOutput: _mockSetOutput,
    mockInfo: _mockInfo,
    mockWarning: _mockWarning,
    mockError: _mockError,
    mockEnsureLabels: _mockEnsureLabels,
    mockPaginate: _mockPaginate,
    mockRunAudit: _mockRunAudit,
    mockCreateIssue: _mockCreateIssue,
    mockPostOrUpdateComment: _mockPostOrUpdateComment,
  };
});

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setFailed: mockSetFailed,
  setOutput: mockSetOutput,
  info: mockInfo,
  warning: mockWarning,
  error: mockError,
}));

import { runAudit } from '../src/audit.js';

const mockEngine = {
  runAudit: mockRunAudit,
} as unknown as ReviewEngine;

const mockGh = {
  ensureLabels: mockEnsureLabels,
  paginate: mockPaginate,
  createIssue: mockCreateIssue,
  postOrUpdateComment: mockPostOrUpdateComment,
} as unknown as PlatformAdapter;

const auditResult = {
  summary: 'Found issues',
  issues: [
    {
      severity: 'critical',
      file: 'src/bug.ts',
      line: 1,
      message: 'Insecure code',
    },
  ],
  stats: { critical: 1, important: 0, minor: 0 },
};

describe('runAudit (action wrapper)', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
    fs.writeFileSync(path.join(tmpDir, 'security.md'), '# Security audit prompt');

    mockGetInput.mockImplementation((name: string) => {
      if (name === 'audit-prompts-dir') {
        return tmpDir;
      }
      return '';
    });
    mockEnsureLabels.mockResolvedValue(undefined);
    mockRunAudit.mockResolvedValue(auditResult);
    mockPaginate.mockResolvedValue([]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the issue without deduplication when the existing-issue search fails', async () => {
    mockPaginate.mockRejectedValue(new Error('GitHub API 500'));
    mockCreateIssue.mockResolvedValue({
      number: 42,
      url: 'https://github.com/owner/repo/issues/42',
    });

    await runAudit(
      makeInputs({ auditCreateIssues: true }),
      makeConfig({
        audit: {
          promptsDir: tmpDir,
          targetDirs: [],
          autoFix: true,
          triggerLabel: 'autofix-trigger',
          issueSeverityThreshold: 'important',
        },
      } as AgentConfig),
      mockEngine,
      mockGh,
    );

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('creating issue without deduplication'),
    );
    expect(mockCreateIssue).toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('fails loudly when both the search and the fallback issue creation fail', async () => {
    mockPaginate.mockRejectedValue(new Error('GitHub API 500'));
    mockCreateIssue.mockResolvedValue(null);

    await runAudit(
      makeInputs({ auditCreateIssues: true }),
      makeConfig({
        audit: {
          promptsDir: tmpDir,
          targetDirs: [],
          autoFix: true,
          triggerLabel: 'autofix-trigger',
          issueSeverityThreshold: 'important',
        },
      } as AgentConfig),
      mockEngine,
      mockGh,
    );

    expect(mockSetFailed).toHaveBeenCalledWith(
      'Audit issue tracking failed — could not create issue',
    );
  });

  it('updates an existing open issue instead of creating a duplicate', async () => {
    mockPaginate.mockResolvedValue([
      { number: 7, title: '[Audit:security] 1 critical, 0 important, 0 minor' },
    ]);

    await runAudit(
      makeInputs({ auditCreateIssues: true }),
      makeConfig({
        audit: {
          promptsDir: tmpDir,
          targetDirs: [],
          autoFix: true,
          triggerLabel: 'autofix-trigger',
          issueSeverityThreshold: 'important',
        },
      } as AgentConfig),
      mockEngine,
      mockGh,
    );

    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      7,
      '<!-- audit-update-security -->',
      expect.stringContaining('## Audit: security'),
    );
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith('issue-number', '7');
  });

  it('skips issue creation when no critical or important findings exist', async () => {
    mockRunAudit.mockResolvedValue({
      summary: 'All good',
      issues: [],
      stats: { critical: 0, important: 0, minor: 3 },
    });

    await runAudit(
      makeInputs({ auditCreateIssues: true }),
      makeConfig({
        audit: {
          promptsDir: tmpDir,
          targetDirs: [],
          autoFix: true,
          triggerLabel: 'autofix-trigger',
          issueSeverityThreshold: 'important',
        },
      } as AgentConfig),
      mockEngine,
      mockGh,
    );

    expect(mockPaginate).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});
