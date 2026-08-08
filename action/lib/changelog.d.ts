import type { AgentConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
/**
 * Run changelog generation: gather merged PRs since the last release tag,
 * categorize them by conventional-commit type, and (when `createPR` is enabled)
 * open a release-prep PR that updates the changelog file from a
 * `changelog/<version>` branch.
 *
 * Changelog generation is GitHub-only: on GitLab the mode reports a failure and
 * returns early. Honors `config.changelog.enabled` and returns early when
 * changelog generation is disabled. Platform reads (`getDefaultBranch`,
 * `getTags`, `getLatestTag`, `getCommitDate`, `listMergedPRs`) are retried on
 * transient failures.
 *
 * Side effects beyond generation: when `changelog.createPR` is enabled, the
 * function commits the generated entry to a `changelog/<version>` branch and
 * pushes it with `--force-with-lease`; on a re-run with no staged changes it
 * skips the commit/push and, if a release-prep PR already exists for the
 * branch, reuses that PR instead of creating a new one.
 *
 * @param config - Full agent configuration.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @returns A promise that resolves once changelog generation (and optionally the
 * release-prep PR) completes. When the platform is GitLab, the function reports
 * failure via `core` and returns early instead of rejecting.
 */
export declare function runChangelog(config: AgentConfig, gh: PlatformAdapter): Promise<void>;
