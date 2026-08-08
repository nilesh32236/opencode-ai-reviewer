import type { AgentConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
/**
 * Run changelog generation: gather merged PRs since the last release tag,
 * categorize them by conventional-commit type, and (when `createPR` is enabled)
 * open a release-prep PR that updates the changelog file from a
 * `changelog/<version>` branch.
 *
 * Changelog generation is GitHub-only: on GitLab the mode reports a failure and
 * returns early. Honors `config.changelog.enabled` and returns early when
 * changelog generation is disabled. Platform reads (`getTags`, `getLatestTag`,
 * `getCommitDate`, `listMergedPRs`) are retried on transient failures.
 *
 * @param config - Full agent configuration.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @returns A promise that resolves once changelog generation (and optionally the
 * release-prep PR) completes. When the PR number cannot be resolved or the
 * platform is GitLab, the function reports failure/skip via `core` and returns
 * early instead of rejecting.
 */
export declare function runChangelog(config: AgentConfig, gh: PlatformAdapter): Promise<void>;
