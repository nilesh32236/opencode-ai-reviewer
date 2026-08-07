import { readFileSync, writeFileSync } from 'fs';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import type { AgentConfig, ChangelogConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
import {
  DEFAULT_CHANGELOG_CONFIG,
  GitHubHelper,
  buildChangelogPRBody,
  generateChangelog,
  validateRefName,
  withRetry,
} from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { resolvePrNumber, sanitize } from './utils.js';

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
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @returns A promise that resolves once changelog generation (and optionally the
 * release-prep PR) completes. When the PR number cannot be resolved or the
 * platform is GitLab, the function reports failure/skip via `core` and returns
 * early instead of rejecting.
 */
export async function runChangelog(
  inputs: ActionInputs,
  config: AgentConfig,
  gh: PlatformAdapter,
): Promise<void> {
  if (config.changelog?.enabled === false) {
    core.info(
      'Skipping changelog mode — changelog generation is disabled (changelog.enabled: false)',
    );
    return;
  }

  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for changelog');
    return;
  }

  if (!(gh instanceof GitHubHelper)) {
    core.setFailed('Changelog generation is only supported on GitHub repositories');
    return;
  }

  const changelogConfig: ChangelogConfig = config.changelog ?? DEFAULT_CHANGELOG_CONFIG;

  const result = await withRetry(() => generateChangelog(gh, changelogConfig, undefined), {
    operationName: 'changelog.generate',
  });

  core.setOutput('changes_made', String(result.entryCount > 0));
  core.setOutput('entry_count', String(result.entryCount));
  core.setOutput('baseline', result.since);
  core.setOutput('baseline_tag', result.tag ?? '');

  if (changelogConfig.outputFormat === 'json') {
    core.setOutput('changelog_json', result.json);
    core.info(result.json);
  } else {
    core.setOutput('changelog_markdown', result.markdown);
    core.info(result.markdown);
  }

  if (result.entryCount === 0) {
    core.info(`No merged PRs found since baseline ${result.since} — nothing to release`);
    return;
  }

  if (!changelogConfig.createPR) {
    core.info('Skipping release-prep PR creation (changelog.createPR: false)');
    return;
  }

  try {
    const version = result.tag ?? `release-${result.since.slice(0, 10)}`;
    const branchName = `${changelogConfig.prBranchPrefix}/${version}`;
    validateRefName(branchName);

    const defaultBranch = await withRetry(() => gh.getDefaultBranch(), {
      operationName: 'changelog.getDefaultBranch',
    });

    await exec.exec('git', ['fetch', 'origin']);
    const branchExists =
      (await exec.exec('git', ['rev-parse', '--verify', `origin/${branchName}`], {
        ignoreReturnCode: true,
      })) === 0;

    if (branchExists) {
      await exec.exec('git', ['checkout', '-B', branchName, `origin/${branchName}`]);
      core.info(`Checked out existing branch ${branchName}`);
      await exec.exec('git', ['pull', '--rebase', 'origin', defaultBranch]);
    } else {
      await exec.exec('git', ['checkout', '-b', branchName, `origin/${defaultBranch}`]);
      core.info(`Created branch ${branchName} from ${defaultBranch}`);
    }

    const changelogPath = changelogConfig.filePath;
    let existingContent: string | null = null;
    try {
      existingContent = readFileSync(changelogPath, 'utf-8');
    } catch {
      existingContent = null;
    }
    writeFileSync(
      changelogPath,
      buildChangelogFileContent(result.markdown, existingContent),
      'utf-8',
    );

    await exec.exec('git', ['add', '-A']);
    await exec.exec('git', ['commit', '-m', `chore(release): update changelog for ${version}`]);
    validateRefName(branchName);
    await exec.exec('git', ['push', 'origin', branchName, '--force-with-lease']);

    const prTitle = `[Changelog] Release notes for ${version}`;
    const prBody = buildChangelogPRBody({
      version,
      changelogMarkdown: result.markdown,
      entryCount: result.entryCount,
      branchName,
    });

    await gh.ensureLabels(['changelog']);
    const newPR = await gh.createPR(prTitle, prBody, branchName, defaultBranch);
    if (newPR) {
      try {
        await gh.addLabels(newPR.number, ['changelog']);
      } catch (err) {
        core.warning(
          sanitize(
            `Failed to label changelog PR #${newPR.number}: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
      core.setOutput('changelog_pr_url', newPR.url);
      core.setOutput('changelog_pr_number', String(newPR.number));
      core.info(`Created changelog PR #${newPR.number}: ${newPR.url}`);
      return;
    }

    core.setFailed(
      `Failed to create changelog PR from branch \`${branchName}\`. A PR may already exist from this branch or the API rejected the request.`,
    );
  } catch (err) {
    core.setFailed(
      sanitize(`Changelog PR creation failed: ${err instanceof Error ? err.message : err}`),
    );
  }
}

/**
 * Prepend the generated changelog entry to an existing changelog file, creating
 * a `# Changelog` file from scratch when none exists.
 * @param newEntry - The generated markdown release-notes entry.
 * @param existing - Existing changelog file content, or null.
 * @returns The full new changelog file content.
 */
function buildChangelogFileContent(newEntry: string, existing: string | null): string {
  const entry = newEntry.trim();
  if (!existing || existing.trim() === '') {
    return `# Changelog\n\n${entry}\n`;
  }
  return `${entry}\n\n---\n\n${existing.trim()}\n`;
}
