import type { PlatformAdapter } from '../platform/adapter.js';
import type { ChangedFile, PRContext, ReviewResult } from '../types/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Logger } from './logger.js';
import { withRetry } from './retry.js';

/**
 * A conventional-commit title plus a set of suggested GitHub labels derived
 * deterministically from the changed files of a pull request.
 */
export interface TitleSuggestion {
  /** Suggested conventional-commit title, e.g. `feat(api): add rate limiting`. */
  title: string;
  /** Suggested label names (list-only — never applied by the reviewer). */
  labels: string[];
}

/** Stable marker prefix used to deduplicate the suggestion comment on re-review. */
export const TITLE_SUGGESTION_MARKER = '<!-- title-suggestion -->';

/** Module-level circuit breaker guarding suggestion-comment posting so a
 * persistently failing GitHub API is short-circuited on later reviews. */
const suggestionCommentBreaker = new CircuitBreaker({ name: 'title-suggestion' });

/** Conventional-commit types recognized when classifying change type. */
const CONVENTIONAL_TYPES = 'feat|fix|docs|chore|refactor|test|build|ci|style|perf|revert' as const;

const CONVENTIONAL_TITLE_RE = new RegExp(`^(${CONVENTIONAL_TYPES})(\\([^)]*\\))?!?:\\s+.+$`, 'i');

const UI_EXTENSION_RE = /\.(tsx|jsx|vue|svelte)$/i;
const CONFIG_EXTENSION_RE = /\.(ya?ml|json|toml|ini|cfg|lock)$/i;
const DOCKERFILE_RE = /(^|\/)dockerfile$/i;
const GITIGNORE_RE = /(^|\/)\.gitignore$/i;
const TEST_FILE_RE = /\.(test|spec)\.[a-z0-9]+$/i;
const TEST_DIR_RE = /(^|\/)(__tests__|tests?|specs?|e2e|integration-tests?)\//i;

/**
 * Check whether a file path looks like a config file (lock, yaml, json, etc.).
 * @param path - The changed file path.
 * @returns True when the path matches a config-file pattern.
 */
function isConfigFile(path: string): boolean {
  return (
    CONFIG_EXTENSION_RE.test(path) ||
    DOCKERFILE_RE.test(path) ||
    GITIGNORE_RE.test(path) ||
    path.endsWith('.dockerignore') ||
    path.endsWith('.gitattributes')
  );
}

/**
 * Check whether a file path looks like a test/spec file or lives in a test dir.
 * @param path - The changed file path.
 * @returns True when the path matches a test file or directory pattern.
 */
function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path) || TEST_DIR_RE.test(path);
}

/**
 * Sum a numeric field across the changed files.
 * @param files - The changed files to sum over.
 * @param pick - Selector for the numeric field to sum.
 * @returns The summed total, or 0 when there are no files.
 */
function sumField(files: ChangedFile[], pick: (file: ChangedFile) => number): number {
  return files.reduce((sum, file) => sum + pick(file), 0);
}

/**
 * Derive the conventional-commit type (feat, fix, docs, chore, test) from the
 * mix of changed files. Rules are applied in priority order and are purely
 * deterministic so the output is stable across runs.
 * @param files - Changed files of the PR.
 * @param additions - Total added lines across the PR.
 * @param deletions - Total deleted lines across the PR.
 * @returns The conventional-commit type.
 */
function classifyChangeType(files: ChangedFile[], additions: number, deletions: number): string {
  const total = files.length;
  if (total === 0) return 'fix';

  const mdCount = files.filter((f) => /\.mdx?$/i.test(f.path)).length;
  if (mdCount === total) return 'docs';

  const configCount = files.filter((f) => isConfigFile(f.path)).length;
  if (configCount === total) return 'chore';

  const testCount = files.filter((f) => isTestFile(f.path)).length;
  if (testCount / total > 0.5) return 'test';

  const uiCount = files.filter((f) => UI_EXTENSION_RE.test(f.path)).length;
  const addsDominant = additions > deletions * 1.3;
  if (uiCount > 0 && addsDominant) return 'feat';

  return 'fix';
}

/**
 * Normalize a top-level directory into a safe conventional-commit scope slug.
 * @param segment - The top-level directory segment to normalize.
 * @returns A lowercased, hyphenated slug safe for a commit scope.
 */
function normalizeScope(segment: string): string {
  const slug = segment
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

/**
 * Derive a conventional-commit scope from the most common top-level directory
 * among the changed files (e.g. `api`, `frontend`, `lib`).
 *
 * Root-level files (paths without a directory separator, e.g. `README.md`) are
 * excluded from the counts entirely so they can never become a scope, and the
 * majority threshold is computed over the number of scoped files rather than
 * the total file count.
 * @param files - Changed files of the PR.
 * @returns A scope slug, or undefined when there is no clear majority directory.
 */
function deriveScope(files: ChangedFile[]): string | undefined {
  const counts = new Map<string, number>();
  let scopedCount = 0;
  for (const file of files) {
    const separatorIndex = file.path.indexOf('/');
    if (separatorIndex === -1) continue;
    const segment = file.path.slice(0, separatorIndex);
    if (!segment) continue;
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
    scopedCount++;
  }
  if (counts.size === 0) return undefined;
  if (counts.size === 1) {
    return normalizeScope([...counts.keys()][0]);
  }
  for (const [dir, count] of counts) {
    if (count / scopedCount > 0.5) return normalizeScope(dir);
  }
  return undefined;
}

/**
 * Strip a conventional-commit prefix, emoji/punctuation, and whitespace from a
 * PR title to produce a clean, lowercased description. The word boundary after
 * the type word prevents prefix stripping from mangling titles that merely
 * start with a type word (e.g. "Fixing the login bug" must not become
 * "ing the login bug").
 * @param title - The PR title to clean.
 * @returns A lowercased description, or 'update' when nothing remains.
 */
function cleanDescription(title: string): string {
  const withoutPrefix = title
    .replace(new RegExp(`^\\s*(${CONVENTIONAL_TYPES})\\b(\\([^)]*\\))?!?:?\\s*`, 'i'), '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/g, '')
    .toLowerCase()
    .trim();
  return withoutPrefix || 'update';
}

/**
 * Derive a conventional-commit title from the PR context.
 *
 * Uses file extensions and directory patterns to determine the type
 * (feat, fix, docs, chore, refactor, test) and the dominant top-level
 * directory as the scope. Falls back to the PR's existing title unchanged when
 * it already matches the conventional-commit format.
 * @param pr - Pull request context.
 * @returns A suggested conventional-commit title.
 */
export function deriveSuggestedTitle(pr: PRContext): string {
  const trimmedTitle = pr.title.trim();
  if (CONVENTIONAL_TITLE_RE.test(trimmedTitle)) {
    return trimmedTitle;
  }

  const files = pr.changedFiles ?? [];
  const additions = sumField(files, (f) => f.additions);
  const deletions = sumField(files, (f) => f.deletions);
  const type = classifyChangeType(files, additions, deletions);
  const scope = deriveScope(files);
  const description = cleanDescription(trimmedTitle);

  return scope ? `${type}(${scope}): ${description}` : `${type}: ${description}`;
}

/**
 * Derive suggested GitHub labels from changed files and optional review
 * findings. Only returns label *names* for the suggestion comment — it never
 * calls the labels API, so it can never modify the repository.
 * @param changedFiles - Changed files of the PR.
 * @param reviewResult - Optional review result used to add severity-based labels.
 * @returns De-duplicated, alphabetically sorted label names.
 */
export function deriveSuggestedLabels(
  changedFiles: ChangedFile[],
  reviewResult?: ReviewResult,
): string[] {
  const labels = new Set<string>();
  const files = changedFiles ?? [];

  for (const file of files) {
    const path = file.path;
    if (DOCKERFILE_RE.test(path)) labels.add('docker');
    if (GITIGNORE_RE.test(path)) labels.add('configuration');
    if (/\.github\/workflows\//i.test(path)) labels.add('ci');
    if (TEST_FILE_RE.test(path) || TEST_DIR_RE.test(path)) labels.add('testing');
    if (/(^|\/)(frontend|app|components|pages|views|ui)\//i.test(path)) {
      labels.add('frontend');
    }
    if (/(^|\/)(backend|api|server|services|controllers)\//i.test(path)) {
      labels.add('backend');
    }
    if (/(^|\/)docs\//i.test(path)) labels.add('documentation');

    if (/\.(ts|tsx|mts|cts)$/i.test(path)) labels.add('typescript');
    if (/\.(js|jsx|mjs|cjs)$/i.test(path)) labels.add('javascript');
    if (/\.(md|mdx)$/i.test(path)) labels.add('documentation');
    if (/\.(yml|yaml)$/i.test(path)) labels.add('configuration');
    if (/\.(json|toml|ini|cfg)$/i.test(path)) labels.add('configuration');
    if (/\.(py)$/i.test(path)) labels.add('python');
    if (/\.(go)$/i.test(path)) labels.add('golang');
    if (/\.(java|kt|kts)$/i.test(path)) labels.add('java/kotlin');
    if (/\.(rs)$/i.test(path)) labels.add('rust');
    if (/\.(rb)$/i.test(path)) labels.add('ruby');
    if (/\.(php)$/i.test(path)) labels.add('php');
    if (/\.(swift)$/i.test(path)) labels.add('swift');
    if (/\.(cs)$/i.test(path)) labels.add('c#');
    if (/\.(css|scss|sass|less)$/i.test(path)) labels.add('css');
    if (/\.(vue|svelte)$/i.test(path)) labels.add('frontend');
  }

  if (reviewResult) {
    const hasHighSeverity = reviewResult.issues.some(
      (issue) => issue.severity === 'critical' || issue.severity === 'important',
    );
    if (hasHighSeverity) labels.add('bugfix');
    if (reviewResult.issues.length === 0) labels.add('enhancement');
  }

  return [...labels].sort();
}

/**
 * Escape backslashes and backticks in a title so PR-controlled input cannot
 * terminate the Markdown inline-code span it is interpolated into. Backslashes
 * are escaped first so a crafted `\`` sequence cannot smuggle a raw backtick
 * through.
 * @param title - The suggested title to escape.
 * @returns The title with backslashes and backticks escaped.
 */
function escapeInlineCode(title: string): string {
  return title.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

/**
 * Build the full suggestion comment markdown body.
 * Includes the suggested conventional-commit title, the suggested labels as a
 * bullet list, and instructions on how to apply the suggestion manually.
 * @param suggestion - Derived title and labels.
 * @param prNumber - PR number referenced in the manual-apply hint.
 * @returns Markdown comment body.
 */
export function buildSuggestionComment(suggestion: TitleSuggestion, prNumber: number): string {
  const labels = suggestion.labels.length
    ? suggestion.labels.map((label) => `- \`${label}\``).join('\n')
    : '- No specific labels suggested';
  const safeTitle = escapeInlineCode(suggestion.title);
  return [
    '## 🏷️ Suggested Title & Labels',
    '',
    `**Suggested title:** \`${safeTitle}\``,
    '',
    '**Suggested labels:**',
    labels,
    '',
    `_This is only a suggestion — nothing is changed automatically. To apply it ` +
      `manually on PR #${prNumber}, set the title to the value above and add the ` +
      'suggested labels in the GitHub UI._',
  ].join('\n');
}

/**
 * Post the title/label suggestion comment to the PR when the feature is
 * enabled. Uses `postOrUpdateComment` with a stable marker so repeated reviews
 * update a single comment instead of spamming the timeline. The external call
 * runs through `withRetry` and a module-level `CircuitBreaker` so a transient
 * API failure retries and a persistently failing endpoint is short-circuited.
 * Returns silently on failure (graceful degradation) and never throws.
 * @param gh - Platform adapter exposing `postOrUpdateComment`.
 * @param prNumber - PR number to comment on.
 * @param pr - Pull request context used to derive the suggestion.
 * @param result - Review result used for severity-based labels.
 * @param config - Config slice controlling whether the feature is enabled.
 * @param config.suggestTitleAndLabels - When true, post the suggestion comment.
 */
export async function postSuggestionComment(
  gh: Pick<PlatformAdapter, 'postOrUpdateComment'>,
  prNumber: number,
  pr: PRContext,
  result: ReviewResult,
  config: { suggestTitleAndLabels?: boolean },
): Promise<void> {
  if (!config.suggestTitleAndLabels) return;
  const logger = new Logger('TitleSuggestion', { prNumber });
  try {
    const suggestion: TitleSuggestion = {
      title: deriveSuggestedTitle(pr),
      labels: deriveSuggestedLabels(pr.changedFiles, result),
    };
    await suggestionCommentBreaker.call(() =>
      withRetry(
        () =>
          gh.postOrUpdateComment(
            prNumber,
            TITLE_SUGGESTION_MARKER,
            buildSuggestionComment(suggestion, prNumber),
          ),
        { operationName: 'title-suggestion', maxRetries: 3 },
      ),
    );
  } catch (err) {
    logger.warn(
      `Failed to post title/label suggestion: ${err instanceof Error ? err.message : String(err)}`,
      { operation: 'review.suggestion' },
    );
  }
}
