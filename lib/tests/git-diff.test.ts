import { describe, expect, it, vi } from 'vitest';
import {
  buildPRContextFromBranchDiff,
  buildPRContextFromStagedDiff,
  parseGitDiff,
  parseGitDiffBlocks,
  parseGitNumstat,
  runGitCommand,
  unquoteGitPath,
} from '../src/git-diff.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import * as cp from 'node:child_process';

const execFileSyncMock = vi.mocked(cp.execFileSync);

/** Default staged diff fixture: one modified file and one added file. */
const STAGED_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index abc123..def456 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '-removed',
  '+added',
  ' line3',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..1234567',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+import x',
  '+export const y = 1;',
].join('\n');

const STAGED_NUMSTAT = '1\t1\tsrc/a.ts\n2\t0\tsrc/new.ts\n';

describe('parseGitDiffBlocks', () => {
  it('parses modified and added files into per-file blocks', () => {
    const blocks = parseGitDiffBlocks(STAGED_PATCH);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      path: 'src/a.ts',
      status: 'modified',
    });
    expect(blocks[1]).toMatchObject({
      path: 'src/new.ts',
      status: 'added',
    });
    expect(blocks[0].patch).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(blocks[1].patch).toContain('new file mode');
  });

  it('detects removed files', () => {
    const patch = [
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      'index abc123..0000000',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    ].join('\n');
    const [block] = parseGitDiffBlocks(patch);
    expect(block.status).toBe('removed');
    expect(block.path).toBe('old.ts');
  });

  it('detects renamed files with the new path', () => {
    const patch = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      'index abc123..def456 100644',
      '--- a/old.ts',
      '+++ b/new.ts',
    ].join('\n');
    const [block] = parseGitDiffBlocks(patch);
    expect(block.status).toBe('renamed');
    expect(block.path).toBe('new.ts');
  });

  it('ignores `+++ ...` hunk content lines that are not path headers', () => {
    const patch = [
      'diff --git a/src/notes.md b/src/notes.md',
      'index abc123..def456 100644',
      '--- a/src/notes.md',
      '+++ b/src/notes.md',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '+++ not a path header',
      '+added',
    ].join('\n');
    const [block] = parseGitDiffBlocks(patch);
    expect(block.path).toBe('src/notes.md');
  });

  it('parses C-quoted diff headers with embedded escapes', () => {
    const patch = [
      'diff --git "a/quote\\"d.txt" "b/quote\\"d.txt"',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ "b/quote\\"d.txt"',
      '@@ -0,0 +1 @@',
      '+x',
    ].join('\n');
    const [block] = parseGitDiffBlocks(patch);
    expect(block.status).toBe('added');
    expect(block.path).toBe('quote"d.txt');
  });

  it('decodes git octal escapes for non-ASCII quoted paths', () => {
    const patch = [
      'diff --git "a/na\\303\\257ve.txt" "b/na\\303\\257ve.txt"',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ "b/na\\303\\257ve.txt"',
      '@@ -0,0 +1 @@',
      '+x',
    ].join('\n');
    const [block] = parseGitDiffBlocks(patch);
    expect(block.path).toBe('naïve.txt');
  });
});

describe('parseGitNumstat', () => {
  it('parses additions/deletions per path', () => {
    const map = parseGitNumstat(STAGED_NUMSTAT);
    expect(map.get('src/a.ts')).toEqual({ additions: 1, deletions: 1 });
    expect(map.get('src/new.ts')).toEqual({ additions: 2, deletions: 0 });
  });

  it('maps binary files (`-`) to zero counts', () => {
    const map = parseGitNumstat('-\t-\tassets/logo.png\n');
    expect(map.get('assets/logo.png')).toEqual({ additions: 0, deletions: 0 });
  });

  it('extracts the new path from rename entries', () => {
    const map = parseGitNumstat('3\t1\tsrc/old.ts => src/new.ts\n');
    expect(map.get('src/new.ts')).toEqual({ additions: 3, deletions: 1 });
    expect(map.has('src/old.ts')).toBe(false);
  });

  it('supports C-quoted paths with spaces', () => {
    const map = parseGitNumstat('1\t1\t"src/my file.ts"\n');
    expect(map.get('src/my file.ts')).toEqual({ additions: 1, deletions: 1 });
  });
});

describe('unquoteGitPath', () => {
  it('returns unquoted paths unchanged', () => {
    expect(unquoteGitPath('src/a.ts')).toBe('src/a.ts');
  });

  it('decodes C-style quoted paths', () => {
    expect(unquoteGitPath('"src/my file.ts"')).toBe('src/my file.ts');
    expect(unquoteGitPath('"a\\tb.ts"')).toBe('a\tb.ts');
  });

  it('decodes git octal escapes as a fallback', () => {
    expect(unquoteGitPath('"na\\303\\257ve.txt"')).toBe('naïve.txt');
  });
});

describe('runGitCommand', () => {
  it('runs git with quotePath=false and a large maxBuffer', () => {
    execFileSyncMock.mockImplementation(
      (
        command: string,
        args: readonly string[],
        options: { maxBuffer?: number; timeout?: number },
      ) => {
        expect(command).toBe('git');
        expect(args[0]).toBe('-c');
        expect(args[1]).toBe('core.quotePath=false');
        expect(options.maxBuffer).toBe(100 * 1024 * 1024);
        expect(options.timeout).toBe(60_000);
        return 'output';
      },
    );
    expect(runGitCommand(['rev-parse', 'HEAD'])).toBe('output');
  });
});

describe('parseGitDiff', () => {
  it('combines patch blocks with numstat counts', () => {
    const changedFiles = parseGitDiff(STAGED_PATCH, STAGED_NUMSTAT);
    expect(changedFiles).toHaveLength(2);
    expect(changedFiles[0]).toMatchObject({
      path: 'src/a.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
    });
    expect(changedFiles[1]).toMatchObject({
      path: 'src/new.ts',
      status: 'added',
      additions: 2,
      deletions: 0,
    });
    expect(changedFiles[0].patch).toContain('@@ -1,3 +1,4 @@');
  });

  it('defaults missing numstat stats to zero', () => {
    const changedFiles = parseGitDiff(STAGED_PATCH, '');
    expect(changedFiles[0].additions).toBe(0);
    expect(changedFiles[0].deletions).toBe(0);
  });
});

describe('buildPRContextFromStagedDiff', () => {
  it('builds a PR context from the staged index diff', () => {
    execFileSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--numstat')) return STAGED_NUMSTAT;
      if (joined.includes('config')) return 'Local Dev';
      if (joined.includes('rev-parse')) return 'deadbeef'.repeat(5);
      if (joined.includes('symbolic-ref')) return 'feature-branch';
      return STAGED_PATCH;
    });

    const pr = buildPRContextFromStagedDiff({ cwd: '/repo' });
    expect(pr.number).toBe(0);
    expect(pr.baseRef).toBe('staged');
    expect(pr.headRef).toBe('feature-branch');
    expect(pr.author).toBe('Local Dev');
    expect(pr.changedFiles).toHaveLength(2);
    expect(pr.changedFiles[0].path).toBe('src/a.ts');
    expect(pr.baseSha).toBe('deadbeef'.repeat(5));
  });
});

describe('buildPRContextFromBranchDiff', () => {
  it('builds a PR context from a branch diff', () => {
    const BRANCH_PATCH = [
      'diff --git a/src/c.ts b/src/c.ts',
      'index abc123..def456 100644',
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const BRANCH_NUMSTAT = '1\t1\tsrc/c.ts\n';

    execFileSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--numstat')) return BRANCH_NUMSTAT;
      if (joined.includes('merge-base')) return 'mergebase'.padEnd(40, '0');
      if (joined.includes('config')) return 'Local Dev';
      if (joined.includes('rev-parse')) return 'deadbeef'.repeat(5);
      if (joined.includes('symbolic-ref')) return 'feature-branch';
      return BRANCH_PATCH;
    });

    const pr = buildPRContextFromBranchDiff('main', { cwd: '/repo' });
    expect(pr.baseRef).toBe('main');
    expect(pr.headRef).toBe('feature-branch');
    expect(pr.changedFiles).toHaveLength(1);
    expect(pr.changedFiles[0].path).toBe('src/c.ts');
    expect(pr.baseSha).toBe('mergebase'.padEnd(40, '0'));
  });

  it('rejects dash-prefixed branch names before reaching git', () => {
    expect(() => buildPRContextFromBranchDiff('--upload-pack=evil', { cwd: '/repo' })).toThrow(
      /must not.*start with "-"/,
    );
    expect(() => buildPRContextFromBranchDiff('', { cwd: '/repo' })).toThrow(/empty/);
  });
});
