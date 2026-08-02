import * as cp from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_BLAME_LINES_PER_FILE,
  getGitBlame,
  parseBlamePorcelain,
  parsePatchHunks,
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
    execFileSync: vi.fn(),
  };
});

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

  it('returns an empty array for patches without hunks', () => {
    expect(parsePatchHunks('+a\n+b\n')).toEqual([]);
    expect(parsePatchHunks('')).toEqual([]);
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
      `${'0'.repeat(40)} 1 5 1`,
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
      commitSha: '0'.repeat(40),
      author: 'Dev',
      date: '2023-11-14',
    });
  });
});

describe('getGitBlame', () => {
  const prCommit = 'f0e2a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c';
  const oldCommit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e';

  beforeEach(() => {
    vi.mocked(cp.execFileSync).mockReset();
  });

  it('runs git blame over the requested ranges and marks PR commits', () => {
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
    vi.mocked(cp.execFileSync).mockReturnValue(porcelain as never);

    const blame = getGitBlame('src/app.ts', [{ start: 1, end: 2 }], {
      cwd: '/repo',
      prCommits: new Set([prCommit]),
    });

    expect(cp.execFileSync).toHaveBeenCalledWith(
      'git',
      ['blame', '--line-porcelain', '-L', '1,2', '--', 'src/app.ts'],
      { encoding: 'utf-8', cwd: '/repo' },
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

  it('treats all lines as PR changes when no PR commit set is provided', () => {
    vi.mocked(cp.execFileSync).mockReturnValue(
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
      ].join('\n') as never,
    );

    const blame = getGitBlame('src/app.ts', [{ start: 1, end: 1 }]);
    expect(blame.get(1)?.isInPRDiff).toBe(true);
  });

  it('returns an empty map when the ranges are empty or exceed the cap', () => {
    expect(getGitBlame('src/app.ts', [])).toEqual(new Map());
    expect(getGitBlame('src/app.ts', [{ start: 1, end: MAX_BLAME_LINES_PER_FILE + 1 }])).toEqual(
      new Map(),
    );
  });

  it('propagates git failures so callers can degrade gracefully', () => {
    vi.mocked(cp.execFileSync).mockImplementation(() => {
      throw new Error('fatal: no such path');
    });
    expect(() => getGitBlame('missing.ts', [{ start: 1, end: 1 }])).toThrow('no such path');
  });
});
