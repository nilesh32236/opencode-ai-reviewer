import { prepareBranchWorkspace, pushBranchWithLease } from '../src/utils/branch-workspace.js';
import { createGuardedCommandSubscriber } from '../src/utils/guarded-subscriber.js';
import {
  extractPRNumberFromText,
  findLinkedPRByMarker,
  findLinkedPRNumberByMarker,
} from '../src/utils/linked-pr.js';
import { hasRepoConfigOverrides } from '../src/utils/repo-config-spec.js';
import { isValidRepoSlug, validateRefName } from '../src/utils/validation.js';
import { runVerificationCycle } from '../src/utils/verify-cycle.js';
import { ensureWorkspaceDeps, resolveInstallPlan } from '../src/utils/workspace-deps.js';

describe('isValidRepoSlug()', () => {
  it('accepts owner/repo and nested groups', () => {
    expect(isValidRepoSlug('octo/repo')).toBe(true);
    expect(isValidRepoSlug('group/sub/repo')).toBe(true);
  });
  it('rejects traversal and bad chars', () => {
    expect(isValidRepoSlug('../evil')).toBe(false);
    expect(isValidRepoSlug('a\\b')).toBe(false);
    expect(isValidRepoSlug('owner/repo:evil')).toBe(false);
    expect(isValidRepoSlug('')).toBe(false);
  });
});

describe('linked-pr helpers', () => {
  it('extracts PR numbers from URL, /pull/, and PR # forms', () => {
    expect(extractPRNumberFromText('see https://github.com/o/r/pull/42 for details')).toBe(42);
    expect(extractPRNumberFromText('fixed in /pull/7')).toBe(7);
    expect(extractPRNumberFromText('PR #99')).toBe(99);
    expect(extractPRNumberFromText('no link')).toBeNull();
  });
  it('finds marker-linked PR numbers', () => {
    const issue = {
      body: 'body',
      comments: [{ body: '<!-- autofix-pr-link -->\n🔧 PR: /pull/12' }],
    };
    expect(findLinkedPRNumberByMarker(issue, '<!-- autofix-pr-link -->')).toBe(12);
    expect(findLinkedPRNumberByMarker(issue, '<!-- other -->')).toBeNull();
  });
  it('finds marker-linked PR number+url', () => {
    const comments = [{ body: '<!-- docs-pr-link -->\n📝 https://github.com/o/r/pull/34' }];
    expect(findLinkedPRByMarker(comments, '<!-- docs-pr-link -->')).toEqual({
      number: 34,
      url: 'https://github.com/o/r/pull/34',
    });
  });
});

describe('resolveInstallPlan()', () => {
  it('uses --frozen-lockfile for lockfileVersion 9', () => {
    expect(
      resolveInstallPlan({
        hasPnpmLock: true,
        hasNpmLock: false,
        pnpmLockContent: 'lockfileVersion: 9',
      }),
    ).toEqual({ program: 'pnpm', args: ['install', '--frozen-lockfile'] });
    expect(
      resolveInstallPlan({
        hasPnpmLock: true,
        hasNpmLock: false,
        pnpmLockContent: 'lockfileVersion: 6',
      }),
    ).toEqual({ program: 'pnpm', args: ['install'] });
    expect(resolveInstallPlan({ hasPnpmLock: false, hasNpmLock: true })).toEqual({
      program: 'npm',
      args: ['ci'],
    });
    expect(resolveInstallPlan({ hasPnpmLock: false, hasNpmLock: false })).toBeNull();
  });
});

describe('ensureWorkspaceDeps()', () => {
  it('installs + builds lib via seams', async () => {
    const calls: Array<{ program: string; args: string[] }> = [];
    const res = await ensureWorkspaceDeps({
      cwd: '/repo',
      existsSync: (p) => p.endsWith('pnpm-lock.yaml'),
      readFileSync: () => 'lockfileVersion: 9',
      run: async (program, args) => {
        calls.push({ program, args });
      },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(res).toEqual({ installed: true });
    expect(calls[0]).toEqual({ program: 'pnpm', args: ['install', '--frozen-lockfile'] });
    expect(calls[1]).toEqual({
      program: 'pnpm',
      args: ['--filter', '@opencode-pr-agent/lib', 'build'],
    });
  });
  it('returns not-installed without lockfile', async () => {
    const res = await ensureWorkspaceDeps({
      cwd: '/repo',
      existsSync: () => false,
      run: async () => {},
      logger: { info: () => {}, warn: () => {} },
    });
    expect(res).toEqual({ installed: false });
  });
});

describe('prepareBranchWorkspace()', () => {
  function mockExecGit(scenario: { exists: boolean; failPush?: boolean }) {
    const calls: string[][] = [];
    const execGit = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && !scenario.exists) {
        throw new Error('unknown revision');
      }
      if (args[0] === 'fetch' && args.includes('--unshallow')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    return { execGit, calls };
  }
  it('creates a fresh branch from origin base', async () => {
    const { execGit, calls } = mockExecGit({ exists: false });
    const res = await prepareBranchWorkspace(execGit, {
      branchName: 'autofix/issue-1',
      defaultBranch: 'main',
      cwd: '/repo',
    });
    expect(res.branchExists).toBe(false);
    expect(res.startRef).toBe('origin/main');
    expect(calls.some((c) => c[0] === 'checkout' && c[1] === '-b')).toBe(true);
  });
  it('checks out + rebases an existing branch', async () => {
    const { execGit } = mockExecGit({ exists: true });
    const res = await prepareBranchWorkspace(execGit, {
      branchName: 'autofix/issue-1',
      defaultBranch: 'main',
      cwd: '/repo',
    });
    expect(res.branchExists).toBe(true);
  });
  it('rejects invalid ref names', async () => {
    const { execGit } = mockExecGit({ exists: false });
    await expect(
      prepareBranchWorkspace(execGit, { branchName: 'bad:ref', defaultBranch: 'main' }),
    ).rejects.toThrow();
  });
  it('skips fork fetch on invalid slug', async () => {
    const { execGit, calls } = mockExecGit({ exists: false });
    await prepareBranchWorkspace(execGit, {
      branchName: 'docs/issue-1',
      defaultBranch: 'main',
      baseRef: 'feature',
      headRepoFullName: '../evil',
      repo: 'owner/repo',
      cwd: '/repo',
      logger: { info: () => {}, warn: () => {} },
    });
    expect(calls.some((c) => c[0] === 'remote')).toBe(false);
  });
  it('pushBranchWithLease validates refs', async () => {
    const { execGit, calls } = mockExecGit({ exists: true });
    await pushBranchWithLease(execGit, { branchName: 'autofix/issue-1', cwd: '/repo' });
    expect(calls[0]).toEqual(['push', 'origin', 'autofix/issue-1', '--force-with-lease']);
    await expect(pushBranchWithLease(execGit, { branchName: 'bad:ref' })).rejects.toThrow();
    expect(() => validateRefName('ok/branch-1')).not.toThrow();
  });
});

describe('runVerificationCycle()', () => {
  it('passes on first attempt', async () => {
    const res = await runVerificationCycle({
      command: 'pnpm test',
      runStep: async () => 'ok',
      logger: { info: () => {}, warn: () => {} },
    });
    expect(res.passed).toBe(true);
    expect(res.attempts).toBe(1);
  });
  it('retries via runFix then passes', async () => {
    let n = 0;
    const res = await runVerificationCycle({
      command: 'pnpm test',
      runStep: async () => {
        n++;
        if (n === 1) throw new Error('fail');
        return 'ok';
      },
      runFix: async () => true,
      logger: { info: () => {}, warn: () => {} },
    });
    expect(res.passed).toBe(true);
    expect(res.attempts).toBe(2);
  });
  it('rejects unsafe commands without running', async () => {
    let ran = false;
    const res = await runVerificationCycle({
      command: 'rm -rf /',
      runStep: async () => {
        ran = true;
        return '';
      },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(res.passed).toBe(false);
    expect(res.attempts).toBe(0);
    expect(ran).toBe(false);
  });
});

describe('createGuardedCommandSubscriber()', () => {
  const baseEvent = (body: string, association?: string) =>
    ({
      type: 'comment.created',
      repo: 'o/r',
      prNumber: 5,
      payload: {
        comment: { body, author_association: association },
        sender: { author_association: association },
      },
      correlationId: 'c',
    }) as unknown as import('../src/types/index.js').GitHubEvent;

  it('denies unprivileged authors without running the handler', async () => {
    let ran = false;
    let denied: string | null = null;
    const sub = createGuardedCommandSubscriber({
      name: 'T',
      command: 'fix',
      events: ['comment.created'],
      privilege: {
        satisfiesPrivilegeGate: () => false,
        postPrivilegeDenial: async (_r, _n, c) => {
          denied = c;
        },
      },
      rateLimit: { checkRateLimit: async () => ({ id: 1 }) },
      handler: async () => {
        ran = true;
      },
    });
    await sub.handle(baseEvent('/fix', 'NONE'), undefined);
    expect(ran).toBe(false);
    expect(denied).toBe('fix');
  });

  it('skips the handler when rate limited', async () => {
    let ran = false;
    const sub = createGuardedCommandSubscriber({
      name: 'T',
      command: 'fix',
      events: ['comment.created'],
      privilege: { satisfiesPrivilegeGate: () => true },
      rateLimit: { checkRateLimit: async () => null },
      handler: async () => {
        ran = true;
      },
    });
    await sub.handle(baseEvent('/fix', 'OWNER'), undefined);
    expect(ran).toBe(false);
  });

  it('runs handler + records rate limit on success', async () => {
    let ran = false;
    let recorded = false;
    const sub = createGuardedCommandSubscriber({
      name: 'T',
      command: 'fix',
      events: ['comment.created'],
      privilege: { satisfiesPrivilegeGate: () => true },
      rateLimit: {
        checkRateLimit: async () => ({ id: 1 }),
        recordRateLimit: async () => {
          recorded = true;
        },
      },
      handler: async () => {
        ran = true;
      },
    });
    await sub.handle(baseEvent('/fix', 'OWNER'), undefined);
    expect(ran).toBe(true);
    expect(recorded).toBe(true);
  });
});

describe('hasRepoConfigOverrides()', () => {
  it('detects each merged section from the single table', () => {
    expect(hasRepoConfigOverrides(null)).toBe(false);
    expect(hasRepoConfigOverrides({})).toBe(false);
    expect(hasRepoConfigOverrides({ sca: { enabled: false } })).toBe(true);
    expect(hasRepoConfigOverrides({ review: { dedup_fingerprints: false } })).toBe(true);
    expect(hasRepoConfigOverrides({ notifications: { slack: {} } })).toBe(true);
  });
});
