/**
 * Types for the `/changelog` command: gathering merged pull requests since the
 * last release tag, categorizing them by conventional-commit type, and
 * generating markdown/JSON release notes.
 */

/**
 * A merged pull request as returned by the GitHub Pulls API. Only the fields
 * the changelog generator consumes are modeled here.
 */
export interface MergedPR {
  /** Pull request number on GitHub. */
  number: number;
  /** Title of the pull request (may carry a conventional-commit prefix). */
  title: string;
  /** Markdown description body of the pull request. */
  body: string;
  /** GitHub username of the PR author. */
  author: string;
  /** ISO 8601 timestamp of when the PR was merged. */
  mergedAt: string;
  /** Base branch the PR was merged into. */
  baseRef: string;
}

/**
 * A single changelog entry derived from a merged PR. `type` carries the raw
 * conventional-commit type (e.g. `feat`, `fix`, `docs`) so callers can filter
 * programmatically; the user-facing category heading is a separate concept
 * derived from the configured category map.
 */
export interface ChangelogEntry {
  /** Conventional-commit type extracted from the PR title (e.g. 'feat'). */
  type: string;
  /** Pull request number on GitHub. */
  prNumber: number;
  /** Cleaned PR title with the conventional-commit prefix stripped. */
  title: string;
  /** GitHub username of the PR author. */
  author: string;
  /** ISO 8601 timestamp of when the PR was merged. */
  mergedAt: string;
  /** Markdown description body of the pull request. */
  body: string;
  /** Conventional-commit scope from the title (e.g. `feat(ui)` → 'ui'). */
  scope?: string;
  /** True when the title carries a breaking-change `!` marker. */
  breaking?: boolean;
}

/** A git tag with its associated commit SHA. */
export interface GitTag {
  /** Tag name (e.g. 'v1.2.3'). */
  name: string;
  /** SHA of the commit the tag points at. */
  commitSha: string;
}

/**
 * User-facing configuration for the `/changelog` command. Mirrors the
 * `changelog:` section of `.opencode-reviewer.yml`.
 */
export interface ChangelogConfig {
  /** Whether the changelog command is enabled (default: false). */
  enabled: boolean;
  /** Output format for the generated release notes (default: 'markdown'). */
  outputFormat: 'markdown' | 'json';
  /**
   * Map of conventional-commit type → category heading shown in the changelog
   * (e.g. `{ feat: 'Features', fix: 'Bug Fixes' }`). Types absent from the map
   * fall into an "Other Changes" heading.
   */
  categories: Record<string, string>;
  /** Repo-relative path of the changelog file to update (default: 'CHANGELOG.md'). */
  filePath: string;
  /** Whether to open a release-prep PR that updates the changelog file (default: false). */
  createPR: boolean;
  /** Branch prefix for the release-prep PR (default: 'changelog'). */
  prBranchPrefix: string;
  /**
   * For monorepo setups: only include PRs whose conventional-commit scope
   * matches this subdirectory. When `includeFiles` is true, PRs are instead
   * matched by their changed file paths.
   */
  subdirectoryFilter?: string;
  /**
   * Opt-in flag to filter monorepo PRs by changed file paths instead of the
   * title's conventional-commit scope. Requires one `GET /pulls/{n}/files` call
   * per merged PR.
   */
  includeFiles: boolean;
  /**
   * ISO 8601 baseline date used when no git tag can be resolved. Defaults to
   * 90 days before now when unset.
   */
  since?: string;
  /**
   * Release target branch used to restrict the merged-PR query (e.g. 'main').
   * When unset, all merged PRs are considered.
   */
  baseBranch?: string;
}

/** The result of a changelog generation run. */
export interface ChangelogResult {
  /** Markdown release notes (identical to `json`'s source entries). */
  markdown: string;
  /** JSON serialization of the categorized entries (when outputFormat is 'json'). */
  json: string;
  /** All changelog entries, flattened across categories. */
  entries: ChangelogEntry[];
  /** Entries grouped by category heading. */
  categorized: Record<string, ChangelogEntry[]>;
  /** Name of the baseline tag, or null when no tag was resolved. */
  tag: string | null;
  /** ISO 8601 baseline date merged PRs were filtered against. */
  since: string;
  /** Total number of changelog entries generated. */
  entryCount: number;
}
