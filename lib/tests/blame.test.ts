import * as cp from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { BlameInfo } from '../src/types/index.js';
import {
  MAX_BLAME_LINES_PER_FILE,
  UNCOMMITTED_SHA,
  filterBlameToPatch,
  getGitBlame,
  parseBlamePorcelain,
  parsePatchHunks,
  parsePatchVisibleLines,
} from '../src/utils/blame.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

function execFileCallback(
  callback: (err: Error | null, stdout?: string) => void,
  stdout = '',
  err: Error | null = null,
) {
  callback(err, stdout);
}

describe('parsePatchHunks', () => {
  it('extracts new-file ranges from hunk headers', () => {
    const patch = ['@@ -1,5 +1,5 @@', ' a', '-b', '+c', '@@ -10,2 +12,4 @@', ' x', '+y', '+z'].join(
      '\n',
    );
    expect(parsePatchHunks(patch)).toEqual([
      { start: 1, end: 5 },
      { start: 12, end: 15 },
    ]);
  });

  it('defaults a hunk without a line count to a single line', () => {
    expect(parsePatchHunks('@@ -1 +7 @@\n+a')).toEqual([{ start: 7, end: 7 }]);
  });

  it('skips deletion-only hunks that have no new-file lines', () => {
    expect(parsePatchHunks('@@ -1,5 +0,0 @@\n-a\n-b\n-c\n-d\n-e')).toEqual([]);
    expect(parsePatchHunks('@@ -9,3 +9,0 @@\n-x\n-y\n-z')).toEqual([]);
  });

  it('keeps valid hunks even when a deletion-only hunk is present', () => {
    const patch = ['@@ -1,5 +0,0 @@', '-a', '-b', '@@ -1,2 +1,2 @@', ' c', '+d'].join('\n');
    expect(parsePatchHunks(patch)).toEqual([{ start: 1, end: 2 }]);
  });

  it('returns an empty array for patches without hunks', () => {
    expect(parsePatchHunks('+a\n+b\n')).toEqual([]);
    expect(parsePatchHunks('')).toEqual([]);
  });
});

describe('parsePatchVisibleLines', () => {
  it('maps context and added lines to new-file line numbers', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c'].join('\n');
    expect(parsePatchVisibleLines(patch)).toEqual(new Set([1, 2]));
  });

  it('omits lines hidden by truncation and deletion-only hunks', () => {
    const patch = ['@@ -1,5 +1,5 @@', ' a', '+b', '+c'].join('\n');
    expect(parsePatchVisibleLines(patch)).toEqual(new Set([1, 2, 3]));
    expect(parsePatchVisibleLines('@@ -1,5 +0,0 @@\n-a\n-b')).toEqual(new Set());
  });
});

describe('filterBlameToPatch', () => {
  it('keeps only lines visible in the given (truncated) patch', () => {
    const blame = new Map<number, BlameInfo>([
      [1, { commitSha: 'a', author: 'A', date: '2023-01-01', isInPRDiff: true }],
      [2, { commitSha: 'b', author: 'B', date: '2023-01-02', isInPRDiff: false }],
      [9, { commitSha: 'c', author: 'C', date: '2023-01-03', isInPRDiff: true }],
    ]);
    const { blame: kept, dropped } = filterBlameToPatch(
      blame,
      ['@@ -1,3 +1,3 @@', ' a', '+b', '+c'].join('\n'),
    );
    expect([...kept.keys()]).toEqual([1, 2]);
    expect(dropped).toBe(1);
  });
});

describe('parseBlamePorcelain', () => {
  const oldCommit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e';
  const prCommit = 'f0e2a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c';

  it('parses per-line attribution with author and date', () => {
    const output = [
      `${oldCommit} 1 12 2`,
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer Alice',
      'committer-mail <alice@example.com>',
      'committer-time 1700000000',
      'committer-tz +0000',
      'summary Refactor',
      '\tline 12',
      `${prCommit} 1 13 1`,
      'author Bob',
      'author-mail <bob@example.com>',
      'author-time 1720000000',
      'author-tz +0000',
      'committer Bob',
      'committer-mail <bob@example.com>',
      'committer-time 1720000000',
      'committer-tz +0000',
      'summary New feature',
      '\tline 13',
    ].join('\n');

    const parsed = parseBlamePorcelain(output);
    expect(parsed.size).toBe(2);
    expect(parsed.get(12)).toEqual({
      commitSha: oldCommit,
      author: 'Alice',
      date: '2023-11-14',
    });
    expect(parsed.get(13)).toEqual({
      commitSha: prCommit,
      author: 'Bob',
      date: '2024-07-03',
    });
  });

  it('handles uncommitted lines (all-zero SHA) and missing metadata', () => {
    const output = [
      `${UNCOMMITTED_SHA} 1 5 1`,
      'author Dev',
      'author-mail <dev@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer Dev',
      'committer-mail <dev@example.com>',
      'committer-time 1700000000',
      'committer-tz +0000',
      'summary Uncommitted',
      '\twork in progress',
    ].join('\n');
    const parsed = parseBlamePorcelain(output);
    expect(parsed.get(5)).toEqual({
      commitSha: UNCOMMITTED_SHA,
      author: 'Dev',
      date: '2023-11-14',
    });
  });
});

describe('getGitBlame', () => {
  const prCommit = 'f0e2a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c';
  const oldCommit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e';

  beforeEach(() => {
    vi.mocked(cp.execFile).mockReset();
  });

  function mockStdout(stdout: string): void {
    vi.mocked(cp.execFile).mockImplementation((_cmd, _args, _opts, cb) => {
      execFileCallback(cb as (err: Error | null, stdout?: string) => void, stdout);
    });
  }

  it('runs git blame over the requested ranges and marks PR commits', async () => {
    const porcelain = [
      `${oldCommit} 1 1 1`,
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer Alice',
      'committer-mail <alice@example.com>',
      'committer-time 1700000000',
      'committer-tz +0000',
      'summary Old',
      '\told line',
      `${prCommit} 1 2 1`,
      'author Bob',
      'author-mail <bob@example.com>',
      'author-time 1720000000',
      'author-tz +0000',
      'committer Bob',
      'committer-mail <bob@example.com>',
      'committer-time 1720000000',
      'committer-tz +0000',
      'summary New',
      '\tnew line',
    ].join('\n');
    mockStdout(porcelain);

    const blame = await getGitBlame('src/app.ts', [{ start: 1, end: 2 }], {
      cwd: '/repo',
      prCommits: new Set([prCommit]),
    });

    expect(cp.execFile).toHaveBeenCalledWith(
      'git',
      ['blame', '--line-porcelain', '-L', '1,2', '--', 'src/app.ts'],
      { cwd: '/repo', encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      expect.any(Function),
    );
    expect(blame.get(1)).toEqual({
      commitSha: oldCommit,
      author: 'Alice',
      date: '2023-11-14',
      isInPRDiff: false,
    });
    expect(blame.get(2)).toEqual({
      commitSha: prCommit,
      author: 'Bob',
      date: '2024-07-03',
      isInPRDiff: true,
    });
  });

  it('blames at the head commit when headSha is provided', async () => {
    mockStdout(`${oldCommit} 1 3 1\nauthor Alice\n\tline\n`);
    await getGitBlame('src/app.ts', [{ start: 3, end: 3 }], {
      cwd: '/repo',
      headSha: 'abc123',
    });
    const call = vi.mocked(cp.execFile).mock.calls[0];
    expect(call[1]).toEqual([
      'blame',
      '--line-porcelain',
      'abc123',
      '-L',
      '3,3',
      '--',
      'src/app.ts',
    ]);
  });

  it('treats all lines as PR changes when no PR commit set is provided', async () => {
    mockStdout(
      [
        `${oldCommit} 1 1 1`,
        'author Alice',
        'author-mail <alice@example.com>',
        'author-time 1700000000',
        'author-tz +0000',
        'committer Alice',
        'committer-mail <alice@example.com>',
        'committer-time 1700000000',
        'committer-tz +0000',
        'summary Old',
        '\told line',
      ].join('\n'),
    );

    const blame = await getGitBlame('src/app.ts', [{ start: 1, end: 1 }]);
    expect(blame.get(1)?.isInPRDiff).toBe(true);
  });

  it('returns an empty map when the ranges are empty or exceed the cap', async () => {
    expect(await getGitBlame('src/app.ts', [])).toEqual(new Map());
    expect(
      await getGitBlame('src/app.ts', [{ start: 1, end: MAX_BLAME_LINES_PER_FILE + 1 }]),
    ).toEqual(new Map());
  });

  it('honors a caller-supplied maxLinesPerFile cap', async () => {
    const blame = await getGitBlame('src/app.ts', [{ start: 1, end: 1500 }], {
      maxLinesPerFile: 100,
    });
    expect(blame).toEqual(new Map());
    expect(cp.execFile).not.toHaveBeenCalled();
  });

  it('propagates git failures so callers can degrade gracefully', async () => {
    vi.mocked(cp.execFile).mockImplementation((_cmd, _args, _opts, cb) => {
      execFileCallback(
        cb as (err: Error | null, stdout?: string) => void,
        '',
        new Error('fatal: no such path'),
      );
    });
    await expect(getGitBlame('missing.ts', [{ start: 1, end: 1 }])).rejects.toThrow('no such path');
  });
});
