import { describe, expect, it, vi } from 'vitest';
import {
  categorizePRs,
  formatJson,
  formatMarkdown,
  generateChangelog,
  monorepoFilter,
} from '../src/changelog/index.js';
import type { MergedPR } from '../src/changelog/types.js';
import type { GitHubHelper } from '../src/utils/github.js';

const CATEGORIES: Record<string, string> = {
  feat: 'Features',
  fix: 'Bug Fixes',
  docs: 'Documentation',
};

const PRS: MergedPR[] = [
  {
    number: 101,
    title: 'feat(ui): add dark mode',
    body: 'Adds a theme toggle.',
    author: 'alice',
    mergedAt: '2026-08-01T10:00:00Z',
    baseRef: 'main',
  },
  {
    number: 102,
    title: 'fix: correct null handling',
    body: 'Guards against null.',
    author: 'bob',
    mergedAt: '2026-08-02T10:00:00Z',
    baseRef: 'main',
  },
  {
    number: 103,
    title: 'feat(api)!: rename endpoints',
    body: 'Breaking API rename.',
    author: 'carol',
    mergedAt: '2026-08-03T10:00:00Z',
    baseRef: 'main',
  },
  {
    number: 104,
    title: 'chore: bump dependencies',
    body: 'Routine bump.',
    author: 'dave',
    mergedAt: '2026-08-04T10:00:00Z',
    baseRef: 'main',
  },
  {
    number: 105,
    title: 'Misc unclassified change',
    body: 'No conventional prefix.',
    author: 'erin',
    mergedAt: '2026-08-05T10:00:00Z',
    baseRef: 'main',
  },
];

describe('categorizePRs', () => {
  it('groups PRs by configured category heading', () => {
    const categorized = categorizePRs(PRS, CATEGORIES);
    expect(categorized.Features.map((e) => e.prNumber)).toEqual([101]);
    expect(categorized['Bug Fixes'].map((e) => e.prNumber)).toEqual([102]);
  });

  it('buckets breaking feat/fix PRs under Breaking Changes', () => {
    const categorized = categorizePRs(PRS, CATEGORIES);
    expect(categorized['Breaking Changes']).toHaveLength(1);
    expect(categorized['Breaking Changes'][0].prNumber).toBe(103);
    expect(categorized['Breaking Changes'][0].breaking).toBe(true);
  });

  it('falls back to Other Changes for unknown types and unprefixed titles', () => {
    const categorized = categorizePRs(PRS, CATEGORIES);
    const other = categorized['Other Changes'];
    expect(other.map((e) => e.prNumber)).toEqual([104, 105]);
  });

  it('strips conventional-commit prefixes from titles and captures scope', () => {
    const categorized = categorizePRs(PRS, CATEGORIES);
    expect(categorized.Features[0].title).toBe('add dark mode');
    expect(categorized.Features[0].scope).toBe('ui');
    expect(categorized['Breaking Changes'][0].title).toBe('rename endpoints');
  });

  it('treats an unprefixed title as type "other"', () => {
    const categorized = categorizePRs(PRS, CATEGORIES);
    const other = categorized['Other Changes'].find((e) => e.prNumber === 105);
    expect(other?.type).toBe('other');
  });
});

describe('formatMarkdown', () => {
  it('renders a heading, subheader, and per-category bullet lists', () => {
    const markdown = formatMarkdown(categorizePRs(PRS, CATEGORIES), {
      tag: 'v1.2.3',
      since: '2026-08-01T00:00:00Z',
      categories: CATEGORIES,
      entryCount: PRS.length,
    });
    expect(markdown).toContain('## v1.2.3');
    expect(markdown).toContain('### Features');
    expect(markdown).toContain('- #101 by @alice: add dark mode');
    expect(markdown).toContain('### Breaking Changes');
  });

  it('orders configured headings by declaration order with breaking/other last', () => {
    const markdown = formatMarkdown(categorizePRs(PRS, CATEGORIES), {
      tag: null,
      since: '2026-08-01T00:00:00Z',
      categories: CATEGORIES,
      entryCount: PRS.length,
    });
    const features = markdown.indexOf('### Features');
    const bugFixes = markdown.indexOf('### Bug Fixes');
    const breaking = markdown.indexOf('### Breaking Changes');
    const other = markdown.indexOf('### Other Changes');
    expect(features).toBeLessThan(bugFixes);
    expect(bugFixes).toBeLessThan(breaking);
    expect(breaking).toBeLessThan(other);
  });

  it('renders an empty-state message when there are no entries', () => {
    const markdown = formatMarkdown(
      {},
      {
        tag: 'v2.0.0',
        since: '2026-08-01T00:00:00Z',
        categories: CATEGORIES,
        entryCount: 0,
      },
    );
    expect(markdown).toContain('No pull requests merged in this range.');
  });

  it('uses Unreleased when no tag is provided', () => {
    const markdown = formatMarkdown(categorizePRs(PRS, CATEGORIES), {
      tag: null,
      since: '2026-08-01T00:00:00Z',
      categories: CATEGORIES,
      entryCount: PRS.length,
    });
    expect(markdown).toContain('## Unreleased');
  });
});

describe('formatJson', () => {
  it('serializes entries as pretty-printed JSON', () => {
    const categorized = categorizePRs(PRS, CATEGORIES);
    const json = formatJson(Object.values(categorized).flat());
    const parsed = JSON.parse(json) as Array<{ prNumber: number }>;
    expect(parsed).toHaveLength(PRS.length);
    expect(parsed[0].prNumber).toBe(101);
  });
});

describe('monorepoFilter', () => {
  const gh = {
    getPRFilePaths: vi.fn(async (prNumber: number) =>
      prNumber === 101 ? ['packages/ui/src/index.ts'] : ['packages/api/src/index.ts'],
    ),
  } as unknown as GitHubHelper;

  it('filters by title scope when includeFiles is false', async () => {
    const categorized = categorizePRs(PRS, CATEGORIES);
    const entries = Object.values(categorized).flat();
    const kept = await monorepoFilter(gh, entries, {
      ...DEFAULT_TEST_CONFIG,
      subdirectoryFilter: 'ui',
      includeFiles: false,
    });
    expect(kept.map((e) => e.prNumber)).toEqual([101]);
  });

  it('filters by changed file paths when includeFiles is true', async () => {
    const entries = Object.values(categorizePRs([PRS[0], PRS[1]], CATEGORIES)).flat();
    const kept = await monorepoFilter(gh, entries, {
      ...DEFAULT_TEST_CONFIG,
      subdirectoryFilter: 'packages/ui',
      includeFiles: true,
    });
    expect(kept.map((e) => e.prNumber)).toEqual([101]);
  });

  it('returns all entries when no subdirectory filter is configured', async () => {
    const entries = [PRS[0], PRS[1]];
    const kept = await monorepoFilter(gh, entries, DEFAULT_TEST_CONFIG);
    expect(kept).toHaveLength(2);
  });
});

describe('generateChangelog', () => {
  const gh = {
    getTags: vi.fn(async () => [{ name: 'v1.1.0', commitSha: 'abc123' }]),
    getLatestTag: vi.fn(async () => ({ name: 'v1.1.0', commitSha: 'abc123' })),
    getCommitDate: vi.fn(async () => '2026-07-15T00:00:00Z'),
    listMergedPRs: vi.fn(async () => PRS),
    getPRFilePaths: vi.fn(async () => []),
  } as unknown as GitHubHelper;

  it('resolves the latest tag baseline and returns markdown + json + entries', async () => {
    const result = await generateChangelog(gh, DEFAULT_TEST_CONFIG);
    expect(gh.getLatestTag).toHaveBeenCalled();
    expect(result.tag).toBe('v1.1.0');
    expect(result.since).toBe('2026-07-15T00:00:00Z');
    expect(result.entryCount).toBe(PRS.length);
    expect(result.markdown).toContain('## v1.1.0');
    expect(JSON.parse(result.json) as Array<{ prNumber: number }>).toHaveLength(PRS.length);
  });

  it('uses an explicit baseline when provided', async () => {
    vi.clearAllMocks();
    const result = await generateChangelog(gh, DEFAULT_TEST_CONFIG, {
      tagName: 'v9.9.9',
      since: '2026-01-01T00:00:00Z',
    });
    expect(result.tag).toBe('v9.9.9');
    expect(result.since).toBe('2026-01-01T00:00:00Z');
    expect(gh.getLatestTag).not.toHaveBeenCalled();
  });

  it('degrades to the configured `since` when no tag exists', async () => {
    const noTagGh = {
      getLatestTag: vi.fn(async () => null),
      getTags: vi.fn(async () => []),
      listMergedPRs: vi.fn(async () => PRS),
    } as unknown as GitHubHelper;
    const result = await generateChangelog(noTagGh, {
      ...DEFAULT_TEST_CONFIG,
      since: '2026-05-01T00:00:00Z',
    });
    expect(result.tag).toBeNull();
    expect(result.since).toBe('2026-05-01T00:00:00Z');
  });

  it('applies the monorepo subdirectory filter', async () => {
    const filteredGh = {
      getLatestTag: vi.fn(async () => ({ name: 'v1.1.0', commitSha: 'abc123' })),
      getCommitDate: vi.fn(async () => '2026-07-15T00:00:00Z'),
      listMergedPRs: vi.fn(async () => PRS),
      getPRFilePaths: vi.fn(async () => ['packages/ui/src/index.ts']),
    } as unknown as GitHubHelper;
    const result = await generateChangelog(filteredGh, {
      ...DEFAULT_TEST_CONFIG,
      subdirectoryFilter: 'ui',
      includeFiles: false,
    });
    expect(result.entries.map((e) => e.prNumber)).toEqual([101]);
  });

  it('passes the abort signal to listMergedPRs', async () => {
    const signal = new AbortController().signal;
    const listGh = {
      getLatestTag: vi.fn(async () => ({ name: 'v1.1.0', commitSha: 'abc123' })),
      getCommitDate: vi.fn(async () => '2026-07-15T00:00:00Z'),
      listMergedPRs: vi.fn(async () => PRS),
    } as unknown as GitHubHelper;
    await generateChangelog(listGh, DEFAULT_TEST_CONFIG, undefined, signal);
    expect(listGh.listMergedPRs).toHaveBeenCalledWith('2026-07-15T00:00:00Z', undefined, signal);
  });
});

const DEFAULT_TEST_CONFIG = {
  enabled: true,
  outputFormat: 'markdown' as const,
  categories: CATEGORIES,
  filePath: 'CHANGELOG.md',
  createPR: false,
  prBranchPrefix: 'changelog',
  includeFiles: false,
};
