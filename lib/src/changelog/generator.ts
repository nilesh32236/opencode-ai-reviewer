/**
 * Core changelog generation logic: categorize merged pull requests by
 * conventional-commit type, filter for monorepo subdirectories, and format the
 * result as markdown or JSON release notes.
 */

import path from 'node:path';

import type { GitHubHelper } from '../utils/github.js';
import { escapeMarkdownText } from '../utils/pr-body.js';
import type { ChangelogConfig, ChangelogEntry, ChangelogResult, MergedPR } from './types.js';

/** Conventional-commit title prefix, e.g. `feat(ui)!: add thing`. */
const CONVENTIONAL_COMMIT_REGEX = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/;

/** Default baseline window (90 days) used when no tag or configured `since` exists. */
const DEFAULT_SINCE_DAYS = 90;

/** Fallback heading for types absent from the configured category map. */
const OTHER_HEADING = 'Other Changes';

/** Heading for PRs whose title carries a breaking-change `!` marker. */
const BREAKING_HEADING = 'Breaking Changes';

/**
 * Options for {@link generateChangelog} used to inject a baseline without
 * resolving it from the GitHub API (primarily for testing).
 */
export interface ChangelogBaseline {
  /** Baseline tag name to display in the output. */
  tagName?: string;
  /** ISO 8601 baseline date merged PRs are filtered against. */
  since?: string;
}

/**
 * Categorize merged PRs into a map of category heading → entries by parsing
 * each PR title for a conventional-commit prefix. PRs whose title carries a
 * breaking-change `!` marker are bucketed under a "Breaking Changes" heading;
 * types absent from the configured category map fall into "Other Changes".
 *
 * @param prs - Merged pull requests to categorize.
 * @param categories - Map of conventional-commit type → category heading.
 * @returns Entries grouped by category heading (insertion order of `categories`,
 * with Breaking/Other appended last).
 */
export function categorizePRs(
  prs: MergedPR[],
  categories: Record<string, string>,
): Record<string, ChangelogEntry[]> {
  const categorized: Record<string, ChangelogEntry[]> = {};

  for (const pr of prs) {
    const match = CONVENTIONAL_COMMIT_REGEX.exec(pr.title.trim());
    const type = match?.[1] ?? '';
    const scope = match?.[2] !== undefined ? match[2] : undefined;
    const breaking = match?.[3] === '!';
    const cleanTitle = match?.[4]?.trim() || pr.title.trim();

    let heading = OTHER_HEADING;
    if (breaking) {
      heading = categories.breaking ?? BREAKING_HEADING;
    } else if (type && categories[type]) {
      heading = categories[type];
    }

    if (!categorized[heading]) categorized[heading] = [];

    categorized[heading].push({
      type: type || 'other',
      prNumber: pr.number,
      title: cleanTitle,
      author: pr.author,
      mergedAt: pr.mergedAt,
      body: pr.body,
      ...(scope !== undefined && { scope }),
      ...(breaking && { breaking }),
    });
  }

  return categorized;
}

/** Options for {@link formatMarkdown}. */
export interface FormatMarkdownOptions {
  /** Baseline tag name shown in the heading (falls back to 'Unreleased'). */
  tag?: string | null;
  /** ISO 8601 baseline date shown in the subheader. */
  since: string;
  /** Category map used for deterministic heading ordering. */
  categories: Record<string, string>;
  /** Total entry count (used to render an empty-state message). */
  entryCount: number;
}

/**
 * Format categorized entries as markdown release notes.
 *
 * @param categorized - Entries grouped by category heading.
 * @param options - Formatting options (tag, baseline date, category order).
 * @returns The formatted markdown string.
 */
export function formatMarkdown(
  categorized: Record<string, ChangelogEntry[]>,
  options: FormatMarkdownOptions,
): string {
  const { tag, since, categories, entryCount } = options;
  const lines: string[] = [];

  lines.push(tag ? `## ${tag}` : '## Unreleased');
  lines.push('');
  lines.push(`_PRs merged since ${tag ?? 'the last release'} (${since.slice(0, 10)})._`);
  lines.push('');

  if (entryCount === 0) {
    lines.push('No pull requests merged in this range.');
    return lines.join('\n');
  }

  for (const heading of orderedHeadings(categorized, categories)) {
    const entries = categorized[heading];
    if (!entries || entries.length === 0) continue;
    lines.push(`### ${heading}`);
    lines.push('');
    for (const entry of entries) {
      lines.push(
        `- #${entry.prNumber} by \`@${singleLine(entry.author)}\`: ${escapeMarkdownText(
          singleLine(entry.title),
        )}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Collapse whitespace — including newlines — in untrusted text so a hostile PR
 * title or author handle cannot break out of a single markdown bullet.
 * @param text - Untrusted text.
 * @returns The text with whitespace runs collapsed to single spaces.
 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Serialize changelog entries as pretty-printed JSON. The full PR body is
 * omitted from the serialized output: it is not needed downstream and keeps
 * the payload small enough to post as a GitHub comment while avoiding
 * surfacing confidential body content in CI logs.
 *
 * @param entries - Flattened changelog entries.
 * @returns The JSON string.
 */
export function formatJson(entries: ChangelogEntry[]): string {
  const safe = entries.map(({ body, ...rest }) => rest);
  return JSON.stringify(safe, null, 2);
}

/**
 * Determine a deterministic category heading order: configured categories in
 * declaration order, then Breaking Changes and Other Changes (when present).
 * @param categorized - Entries grouped by heading.
 * @param categories - Configured type → heading map.
 * @returns Ordered list of headings that have at least one entry.
 */
function orderedHeadings(
  categorized: Record<string, ChangelogEntry[]>,
  categories: Record<string, string>,
): string[] {
  const configured = new Set(Object.values(categories));
  const present = new Set(Object.keys(categorized));
  const ordered = [
    ...[...configured].filter((h) => present.has(h)),
    BREAKING_HEADING,
    OTHER_HEADING,
  ];
  return [...new Set(ordered)].filter((h) => present.has(h));
}

/**
 * Filter entries to those matching a monorepo subdirectory. By default the
 * filter matches the PR title's conventional-commit scope; when `includeFiles`
 * is set, it matches the union of the PR's changed file paths instead.
 *
 * When `includeFiles` is enabled the per-PR file lookups run with bounded
 * concurrency (up to {@link MONOREPO_CONCURRENCY} in flight at once), and a
 * failed lookup skips that entry rather than aborting the whole generation.
 *
 * @param gh - GitHubHelper used to fetch per-PR file lists when `includeFiles` is set.
 * @param entries - Entries to filter.
 * @param config - Changelog config carrying `subdirectoryFilter` and `includeFiles`.
 * @returns Entries that match the configured subdirectory.
 */
export async function monorepoFilter(
  gh: GitHubHelper,
  entries: ChangelogEntry[],
  config: ChangelogConfig,
): Promise<ChangelogEntry[]> {
  const filter = config.subdirectoryFilter?.trim();
  if (!filter) return entries;

  if (!config.includeFiles) {
    return entries.filter((e) => e.scope !== undefined && scopeMatchesFilter(e.scope, filter));
  }

  const kept: ChangelogEntry[] = [];
  for (let i = 0; i < entries.length; i += MONOREPO_CONCURRENCY) {
    const batch = entries.slice(i, i + MONOREPO_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry): Promise<ChangelogEntry | null> => {
        try {
          const paths = await gh.getPRFilePaths(entry.prNumber);
          return paths.some((p) => pathMatchesFilter(p, filter)) ? entry : null;
        } catch {
          // A failed per-PR file lookup should not abort the whole generation:
          // skip the entry so the remaining PRs still produce release notes.
          return null;
        }
      }),
    );
    for (const result of results) {
      if (result) kept.push(result);
    }
  }
  return kept;
}

/** Max concurrent `getPRFilePaths` requests issued by {@link monorepoFilter}. */
const MONOREPO_CONCURRENCY = 5;

/**
 * Match a file path against a subdirectory filter (repo-relative prefix match).
 * @param path - Repo-relative file path.
 * @param filter - Configured subdirectory (e.g. 'packages/ui').
 * @returns True when the path lives under the subdirectory.
 */
function pathMatchesFilter(path: string, filter: string): boolean {
  const normalizedFilter = filter.replace(/\/+$/, '');
  return path === normalizedFilter || path.startsWith(`${normalizedFilter}/`);
}

/**
 * Match a conventional-commit scope against a subdirectory filter. Matches when
 * the scope equals the filter, is a prefix of it, or the filter is a prefix of
 * the scope (case-insensitive) so `feat(ui):` satisfies `ui` or `ui/button`.
 * @param scope - Conventional-commit scope (e.g. 'ui').
 * @param filter - Configured subdirectory filter.
 * @returns True when the scope matches the filter.
 */
function scopeMatchesFilter(scope: string, filter: string): boolean {
  const s = scope.toLowerCase();
  const f = filter.toLowerCase().replace(/\/+$/, '');
  return s === f || s.startsWith(f) || f.startsWith(s);
}

/**
 * Compute an ISO 8601 fallback baseline date (90 days before now).
 * @returns ISO date string.
 */
function fallbackSince(): string {
  return new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Orchestrator: resolve the latest release tag (or use the provided baseline),
 * list merged PRs since the baseline, categorize, apply the optional monorepo
 * filter, and format the result.
 *
 * @param gh - GitHubHelper for tag/PR/file lookups.
 * @param config - Changelog configuration.
 * @param baseline - Optional explicit baseline (used by callers/tests that have
 * already resolved a tag or want a fixed `since` date).
 * @param signal - Optional AbortSignal to cancel the underlying API requests.
 * @returns The generated changelog result.
 */
export async function generateChangelog(
  gh: GitHubHelper,
  config: ChangelogConfig,
  baseline?: ChangelogBaseline,
  signal?: AbortSignal,
): Promise<ChangelogResult> {
  let tagName: string | null = baseline?.tagName ?? null;
  let since: string | undefined = baseline?.since;

  if (since === undefined) {
    // Resolve the latest tag (API preferred per the maintainer decision) and
    // derive the baseline date from its commit; degrade gracefully to a
    // configured `since` or a 90-day window when no tag/commit date is usable.
    let commitSha: string | undefined;
    if (tagName === null) {
      const latestTag = await gh.getLatestTag();
      tagName = latestTag?.name ?? null;
      commitSha = latestTag?.commitSha;
    } else {
      const tags = await gh.getTags();
      commitSha = tags.find((t) => t.name === tagName)?.commitSha;
    }

    if (tagName) {
      const date = commitSha ? await gh.getCommitDate(commitSha) : null;
      since = date ?? config.since ?? fallbackSince();
    } else {
      since = config.since ?? fallbackSince();
    }
  }

  const baseBranch = await gh.getDefaultBranch();
  const mergedPRs = await gh.listMergedPRs(since, baseBranch, signal);

  let categorized = categorizePRs(mergedPRs, config.categories);

  if (config.subdirectoryFilter) {
    const filtered: Record<string, ChangelogEntry[]> = {};
    for (const [heading, entries] of Object.entries(categorized)) {
      const kept = await monorepoFilter(gh, entries, config);
      if (kept.length > 0) filtered[heading] = kept;
    }
    categorized = filtered;
  }

  const allEntries = Object.values(categorized).flat();

  return {
    markdown: formatMarkdown(categorized, {
      tag: tagName,
      since,
      categories: config.categories,
      entryCount: allEntries.length,
    }),
    json: formatJson(allEntries),
    entries: allEntries,
    categorized,
    tag: tagName,
    since,
    entryCount: allEntries.length,
  };
}

/**
 * Resolve a repo-relative changelog file path against a working root,
 * rejecting any path that escapes the root via an absolute value or parent
 * traversal. Confines `changelog.filePath` — which comes from a repo-owned
 * `.opencode-reviewer.yml` — to the checkout so a malformed config cannot
 * overwrite arbitrary files on the runner or host.
 *
 * @param root - Working root directory (repo checkout or clone temp dir).
 * @param filePath - Repo-relative changelog file path.
 * @returns The resolved absolute path, guaranteed to stay inside `root`.
 * @throws When the resolved path escapes the root.
 */
export function resolveSafeChangelogPath(root: string, filePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, filePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`changelog.filePath escapes the repo directory: ${filePath}`);
  }
  return resolved;
}

/**
 * Build the changelog file content for a release-prep PR by prepending the
 * generated release-notes entry. Idempotent: when the entry already exists in
 * the file (a re-run against the same baseline), the existing content is
 * returned unchanged so release-prep re-runs become no-ops instead of
 * duplicating entries or failing an empty git commit.
 *
 * @param newEntry - The generated markdown release-notes entry.
 * @param existing - Existing changelog file content, or null.
 * @returns The full new changelog file content.
 */
export function buildChangelogFileContent(newEntry: string, existing: string | null): string {
  const entry = newEntry.trim();
  if (existing?.includes(entry)) {
    return `${existing.trim()}\n`;
  }
  if (!existing || existing.trim() === '') {
    return `# Changelog\n\n${entry}\n`;
  }
  return `${entry}\n\n---\n\n${existing.trim()}\n`;
}
