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
  mockAddLabels,
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
  const _mockAddLabels = vi.fn();
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
    mockAddLabels: _mockAddLabels,
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

import { resetAuditIssueRegistry, runAudit } from '../src/audit.js';

const mockEngine = {
  runAudit: mockRunAudit,
} as unknown as ReviewEngine;

const mockGh = {
  ensureLabels: mockEnsureLabels,
  paginate: mockPaginate,
  createIssue: mockCreateIssue,
  postOrUpdateComment: mockPostOrUpdateComment,
  addLabels: mockAddLabels,
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

// #955. The credential split needs the unprivileged half of the audit to hand
// its findings onward WITHOUT being allowed to file anything, which it cannot
// do unless the payload is emitted independently of `audit_create_issues`.
// Two tests, one per value of that flag, because the property is precisely that
// the flag does not matter — a single test could pass for the wrong reason.
describe('audit_findings output (#955 credential split)', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditIssueRegistry();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-findings-'));
    fs.writeFileSync(path.join(tmpDir, 'security.md'), '# Security audit prompt');

    mockGetInput.mockImplementation((name: string) => (name === 'audit-prompts-dir' ? tmpDir : ''));
    mockEnsureLabels.mockResolvedValue(undefined);
    mockRunAudit.mockResolvedValue(auditResult);
    mockPaginate.mockResolvedValue([]);
    mockAddLabels.mockResolvedValue(undefined);
    mockCreateIssue.mockResolvedValue({ number: 1 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const emitted = (): Record<string, unknown> | null => {
    const call = mockSetOutput.mock.calls.find(([name]) => name === 'audit_findings');
    if (!call) {
      return null;
    }
    return JSON.parse(String(call[1])) as Record<string, unknown>;
  };

  const run = (auditCreateIssues: boolean) =>
    runAudit(
      makeInputs({ auditCreateIssues }),
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

  it('emits the findings when issue creation is OFF — the unprivileged half of the split', async () => {
    await run(false);

    // The whole point: nothing was filed, and the payload still arrived.
    expect(mockCreateIssue).not.toHaveBeenCalled();

    const payload = emitted();
    expect(payload, 'findings must be emitted with audit_create_issues off').not.toBeNull();
    expect(payload?.summary).toBe('Found issues');
    expect(payload?.stats).toEqual({ critical: 1, important: 0, minor: 0 });
    expect(payload?.issues).toEqual([
      { severity: 'critical', file: 'src/bug.ts', line: 1, message: 'Insecure code' },
    ]);
    expect(typeof payload?.category).toBe('string');
    expect(typeof payload?.target).toBe('string');
  });

  it('emits the same findings when issue creation is ON, so the two halves agree', async () => {
    await run(true);

    expect(mockCreateIssue).toHaveBeenCalled();

    const payload = emitted();
    expect(payload, 'findings must be emitted with audit_create_issues on too').not.toBeNull();
    expect(payload?.issues).toEqual([
      { severity: 'critical', file: 'src/bug.ts', line: 1, message: 'Insecure code' },
    ]);
  });

  it('emits an EMPTY issues array for an audit that legitimately found nothing', async () => {
    mockRunAudit.mockResolvedValue({
      summary: '',
      issues: [],
      stats: { critical: 0, important: 0, minor: 0 },
    } as unknown as Awaited<ReturnType<typeof mockRunAudit>>);

    await run(false);

    // "ran, found none" must be distinguishable from "never ran", or the
    // downstream job cannot tell an empty audit from a refused one.
    const payload = emitted();
    expect(
      payload,
      'an empty-but-real audit still has to publish its (empty) findings',
    ).not.toBeNull();
    expect(payload?.issues).toEqual([]);
  });

  it('emits NOTHING when the audit produced no result — a refusal is not a clean audit', async () => {
    mockRunAudit.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof mockRunAudit>>);

    await run(false);

    expect(mockSetFailed).toHaveBeenCalled();
    expect(
      emitted(),
      'no result means nothing was audited; an empty payload here would read as clean',
    ).toBeNull();
  });

  // The AI review on this PR caught this: the first version of the output
  // published the raw LLM text while `buildAuditIssueBody` printed
  // `[REDACTED]` for the same fields. A step output becomes an artifact a later
  // job reads, and the whole point of this output is to hand it to a
  // PRIVILEGED job — so an unredacted payload is strictly worse than no payload.
  // Pinned here so it cannot come back.
  it('REDACTS secrets in the findings it emits, matching the issue body', async () => {
    // NOTE: synthetic fixtures only — these are documented example-shaped
    // values, assembled at runtime so no credential-shaped literal is
    // stored in the repo (neither the AKIA prefix nor the github_pat_
    // prefix appears contiguously in source), and they match no real account.
    const SECRET = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');
    const PAT = ['github_', 'pat_', '11ABCDEFG0', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    mockRunAudit.mockResolvedValue({
      summary: `Scan complete; ${PAT} was hardcoded`,
      issues: [
        {
          severity: 'critical',
          file: 'src/bug.ts',
          line: 1,
          message: `Leaked AWS key ${SECRET}`,
          suggestion: `Rotate the key ${SECRET}`,
          // ReviewIssue also carries `suggestionCode`: raw repository source
          // text for a GitHub suggestion diff. buildAuditIssueBody omits it
          // entirely, and an earlier version of this output leaked it via
          // `{ ...issue }` — which is why the payload is an allowlist and why
          // this field is seeded here.
          suggestionCode: `const key = "${SECRET}";`,
        },
      ],
      stats: { critical: 1, important: 0, minor: 0 },
    } as unknown as Awaited<ReturnType<typeof mockRunAudit>>);

    await run(false);

    const payload = emitted();
    const serialised = JSON.stringify(payload);
    expect(serialised, 'a secret must never survive into a step output').not.toContain(SECRET);
    expect(serialised, 'a PAT must never survive into a step output').not.toContain(PAT);

    // And the fields that were supposed to carry them must still be present, so
    // this cannot be satisfied by dropping the fields wholesale.
    expect(payload?.summary).toMatch(/REDACTED/);
    const issues = payload?.issues as Array<{
      message: string;
      suggestion?: string;
      suggestionCode?: string;
    }>;
    expect(issues[0]?.message).toMatch(/REDACTED/);
    expect(issues[0]?.suggestion).toMatch(/REDACTED/);

    // Not redacted — OMITTED. `suggestionCode` is raw repo source that the
    // issue body never renders, so carrying it at all would be the leak.
    expect(
      'suggestionCode' in (issues[0] as object),
      'suggestionCode must be omitted from a public artifact, not merely redacted',
    ).toBe(false);
  });

  // #955 follow-up: the split's downstream job must tell "ran" from
  // "never ran". `status: "complete"` is that attested-completion marker —
  // present on every path that produced a result (even an empty one), absent
  // on the refusal path (which emits nothing and fails).
  it('marks every emitted payload status:"complete"', async () => {
    await run(false);

    expect(emitted()?.status).toBe('complete');
  });

  it('marks even the attested-empty payload status:"complete"', async () => {
    mockRunAudit.mockResolvedValue({
      summary: '',
      issues: [],
      stats: { critical: 0, important: 0, minor: 0 },
    } as unknown as Awaited<ReturnType<typeof mockRunAudit>>);

    await run(false);

    const payload = emitted();
    expect(payload?.status).toBe('complete');
    expect(payload?.issues).toEqual([]);
  });

  // The unprivileged half holds no GitHub credential, so the read-only path
  // must not make authenticated label-setup calls (and needs none — labels
  // are only used when filing issues).
  it('makes no label-setup calls on the read-only path', async () => {
    await run(false);

    expect(mockEnsureLabels).not.toHaveBeenCalled();
  });

  it('still sets up labels when issue creation is on', async () => {
    await run(true);

    expect(mockEnsureLabels).toHaveBeenCalled();
  });

  // A writing run with no credential must fail loudly rather than silently
  // degrade into a read-only run that reports success with nothing filed.
  it('fails closed when issue creation is on but no token is configured', async () => {
    await runAudit(
      makeInputs({ auditCreateIssues: true, githubToken: '' }),
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

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('without a github_token'));
    expect(emitted(), 'a refused write must not publish findings that read as a result').toBeNull();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEnsureLabels).not.toHaveBeenCalled();
  });
});

describe('runAudit (action wrapper)', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditIssueRegistry();

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
    mockAddLabels.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Issue #924: an audit that never ran must not report success. The engine
  // returning no result at all is unambiguous — nothing was audited — so it
  // must fail the job rather than warn and return 0.
  it('FAILS the job when the engine produces no result at all', async () => {
    mockRunAudit.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof mockRunAudit>>);

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

    expect(mockSetFailed).toHaveBeenCalled();
    expect(mockWarning, 'must not be a warning-only path').not.toHaveBeenCalledWith(
      expect.stringContaining('no summary and no findings'),
    );
    expect(
      mockCreateIssue,
      'nothing was audited, so no issue should be filed',
    ).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('STILL warns (not fails) when an audit legitimately returns no findings', async () => {
    mockRunAudit.mockResolvedValue({
      summary: '',
      issues: [],
      stats: { critical: 0, important: 0, minor: 0 },
    } as unknown as Awaited<ReturnType<typeof mockRunAudit>>);

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

    expect(mockSetFailed, 'an empty-but-real audit must not turn CI red').not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('no summary and no findings'));
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

  it('fails loudly when updating an existing audit issue fails', async () => {
    mockPaginate.mockResolvedValue([
      { number: 7, title: '[Audit:security] 1 critical, 0 important, 0 minor' },
    ]);
    mockPostOrUpdateComment.mockRejectedValue(new Error('GitHub API 500'));

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
      'Audit issue tracking failed — could not update issue',
    );
  });

  it('reuses the last tracked issue when the search keeps failing (no duplicate create)', async () => {
    mockPaginate.mockRejectedValue(new Error('GitHub API 500'));
    mockCreateIssue.mockResolvedValue({
      number: 42,
      url: 'https://github.com/owner/repo/issues/42',
    });

    const inputs = makeInputs({ auditCreateIssues: true });
    const config = makeConfig({
      audit: {
        promptsDir: tmpDir,
        targetDirs: [],
        autoFix: true,
        triggerLabel: 'autofix-trigger',
        issueSeverityThreshold: 'important',
      },
    } as AgentConfig);

    // First fail-open run creates the issue and records it.
    await runAudit(inputs, config, mockEngine, mockGh);
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);

    // Second fail-open run reuses the recorded issue number via an update
    // instead of creating a second duplicate.
    await runAudit(inputs, config, mockEngine, mockGh);
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- audit-update-security -->',
      expect.stringContaining('## Audit: security'),
    );
  });

  it('slugs audit categories containing reserved characters before building query and labels', async () => {
    fs.writeFileSync(path.join(tmpDir, 'my audit&prompt.md'), '# Custom audit prompt');
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'audit-prompts-dir') {
        return tmpDir;
      }
      if (name === 'audit-prompt-name') {
        return 'my audit&prompt';
      }
      return '';
    });
    mockCreateIssue.mockResolvedValue({
      number: 50,
      url: 'https://github.com/owner/repo/issues/50',
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

    // The reserved characters are normalized to hyphens and a deterministic
    // hash of the original category is appended so colliding slugs stay unique.
    expect(mockPaginate).toHaveBeenCalledWith(
      '/issues?state=open&labels=audit:my-audit-prompt-jexvst',
      expect.anything(),
    );
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.stringContaining('[Audit:my-audit-prompt-jexvst]'),
      expect.any(String),
      expect.arrayContaining(['audit:my-audit-prompt-jexvst']),
    );
  });

  it('keeps distinct categories that normalize to the same slug separate', async () => {
    fs.writeFileSync(path.join(tmpDir, 'auth & access.md'), '# Auth access prompt');
    fs.writeFileSync(path.join(tmpDir, 'auth # access.md'), '# Auth access prompt 2');
    mockCreateIssue.mockResolvedValue({
      number: 60,
      url: 'https://github.com/owner/repo/issues/60',
    });

    const auditConfig = makeConfig({
      audit: {
        promptsDir: tmpDir,
        targetDirs: [],
        autoFix: true,
        triggerLabel: 'autofix-trigger',
        issueSeverityThreshold: 'important',
      },
    } as AgentConfig);

    mockGetInput.mockImplementation((name: string) => {
      if (name === 'audit-prompts-dir') {
        return tmpDir;
      }
      if (name === 'audit-prompt-name') {
        return 'auth & access';
      }
      return '';
    });
    await runAudit(makeInputs({ auditCreateIssues: true }), auditConfig, mockEngine, mockGh);

    mockGetInput.mockImplementation((name: string) => {
      if (name === 'audit-prompts-dir') {
        return tmpDir;
      }
      if (name === 'audit-prompt-name') {
        return 'auth # access';
      }
      return '';
    });
    await runAudit(makeInputs({ auditCreateIssues: true }), auditConfig, mockEngine, mockGh);

    // "auth & access" and "auth # access" both normalize to "auth-access", so
    // the deterministic hash suffix must keep them from sharing a label, query,
    // title prefix, or issue.
    expect(mockPaginate).toHaveBeenCalledWith(
      '/issues?state=open&labels=audit:auth-access-bvdrze',
      expect.anything(),
    );
    expect(mockPaginate).toHaveBeenCalledWith(
      '/issues?state=open&labels=audit:auth-access-rb556v',
      expect.anything(),
    );
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.stringContaining('[Audit:auth-access-bvdrze]'),
      expect.any(String),
      expect.arrayContaining(['audit:auth-access-bvdrze']),
    );
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.stringContaining('[Audit:auth-access-rb556v]'),
      expect.any(String),
      expect.arrayContaining(['audit:auth-access-rb556v']),
    );
  });

  it('truncates an audit category that is already a valid slug but exceeds the label limit', async () => {
    // A prompt name that is already a valid lowercase slug but longer than 44
    // characters must still be truncated, otherwise `audit:` + slug exceeds
    // GitHub's 50-character label limit and issue creation fails with a 422.
    const longName = `${'security-conventions'.repeat(3)}check`; // 60-char valid slug
    fs.writeFileSync(path.join(tmpDir, `${longName}.md`), '# Long audit prompt');
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'audit-prompts-dir') {
        return tmpDir;
      }
      if (name === 'audit-prompt-name') {
        return longName;
      }
      return '';
    });
    mockCreateIssue.mockResolvedValue({
      number: 61,
      url: 'https://github.com/owner/repo/issues/61',
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

    const truncated = longName.slice(0, 44);
    expect(truncated.length).toBe(44);
    expect(mockPaginate).toHaveBeenCalledWith(
      `/issues?state=open&labels=audit:${truncated}`,
      expect.anything(),
    );
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.stringContaining(`[Audit:${truncated}]`),
      expect.any(String),
      expect.arrayContaining([`audit:${truncated}`]),
    );
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

  it('creates without the trigger then attaches it trailing when auditAutoFix is enabled', async () => {
    mockCreateIssue.mockResolvedValue({
      number: 42,
      url: 'https://github.com/owner/repo/issues/42',
    });

    await runAudit(
      makeInputs({ auditCreateIssues: true, auditAutoFix: true }),
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

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    const createLabels = mockCreateIssue.mock.calls[0][2] as string[];
    expect(createLabels).not.toContain('autofix-trigger');
    expect(mockAddLabels).toHaveBeenCalledTimes(1);
    expect(mockAddLabels).toHaveBeenCalledWith(42, ['autofix-trigger']);
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('never attaches the trigger when auditAutoFix is disabled', async () => {
    mockCreateIssue.mockResolvedValue({
      number: 43,
      url: 'https://github.com/owner/repo/issues/43',
    });

    await runAudit(
      makeInputs({ auditCreateIssues: true, auditAutoFix: false }),
      makeConfig({
        audit: {
          promptsDir: tmpDir,
          targetDirs: [],
          autoFix: false,
          triggerLabel: 'autofix-trigger',
          issueSeverityThreshold: 'important',
        },
      } as AgentConfig),
      mockEngine,
      mockGh,
    );

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('warns fail-open without setFailed when the trailing trigger attach fails', async () => {
    mockCreateIssue.mockResolvedValue({
      number: 44,
      url: 'https://github.com/owner/repo/issues/44',
    });
    mockAddLabels.mockRejectedValue(new Error('label API 500'));

    await runAudit(
      makeInputs({ auditCreateIssues: true, auditAutoFix: true }),
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

    expect(mockAddLabels).toHaveBeenCalledWith(44, ['autofix-trigger']);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('autofix-trigger'));
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('filters autofix-trigger out of bulk create labels when present in auditLabels', async () => {
    mockCreateIssue.mockResolvedValue({
      number: 45,
      url: 'https://github.com/owner/repo/issues/45',
    });

    await runAudit(
      makeInputs({
        auditCreateIssues: true,
        auditAutoFix: true,
        auditLabels: ['audit', 'autofix-trigger'],
      }),
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

    const createLabels = mockCreateIssue.mock.calls[0][2] as string[];
    expect(createLabels).not.toContain('autofix-trigger');
    // The trailing attach remains the sole source of the trigger.
    expect(mockAddLabels).toHaveBeenCalledWith(45, ['autofix-trigger']);
  });

  it('re-attaches the trigger on the dedup-update path when auditAutoFix is enabled', async () => {
    mockPaginate.mockResolvedValue([
      { number: 7, title: '[Audit:security] 1 critical, 0 important, 0 minor' },
    ]);
    mockPostOrUpdateComment.mockResolvedValue(undefined);

    await runAudit(
      makeInputs({ auditCreateIssues: true, auditAutoFix: true }),
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

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      7,
      '<!-- audit-update-security -->',
      expect.stringContaining('## Audit: security'),
    );
    expect(mockAddLabels).toHaveBeenCalledWith(7, ['autofix-trigger']);
    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});
