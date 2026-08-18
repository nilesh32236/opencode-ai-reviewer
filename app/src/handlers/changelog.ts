import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type {
  AgentConfig,
  ChangelogConfig,
  ChangelogResult,
  EventBus,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import {
  DEFAULT_CHANGELOG_CONFIG,
  GitHubHelper,
  Logger,
  buildChangelogPRBody,
  generateChangelog,
  sanitizeErrorMessage,
  validateRefName,
} from '@opencode-pr-agent/lib';
import { execGit } from '../utils/git.js';
import type { ExecGitOptions } from '../utils/git.js';

/** Module-scope logger for helper functions that have no per-call context. */
const logger = new Logger('Changelog');

/**
 * Handle a `/changelog` command: gather merged PRs since the latest release
 * tag, categorize them by conventional-commit type, post the generated release
 * notes as a comment, and (optionally) open a release-prep PR that updates the
 * changelog file from a dedicated `changelog/<version>` branch (mirrors the
 * docs command's branch → commit → push → PR flow). The source PR is never
 * modified.
 *
 * Changelog generation is GitHub-only: on GitLab it posts a brief notice and
 * returns without error. Honors `config.changelog.enabled === false`.
 *
 * @param gh - Platform adapter. Must be a GitHubHelper for changelog generation.
 * @param issueNumber - The PR/issue number that triggered the command.
 * @param repo - Repository string (owner/repo).
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory containing the cloned repo.
 * @param gitEnv - Optional git environment variables for authenticated commands.
 * @param signal - Optional abort signal.
 * @returns A promise that resolves once the changelog comment (and optional PR)
 * is posted, or an error comment is posted on failure.
 */
export async function handleChangelogCommand(
  gh: PlatformAdapter,
  issueNumber: number,
  repo: string,
  config: AgentConfig,
  tempDir: string,
  gitEnv?: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const log = new Logger('Command:Changelog', { repo, prNumber: issueNumber });
  log.info(`Changelog triggered for #${issueNumber}`);

  if (config.changelog?.enabled === false) {
    log.info('Changelog generation is disabled (changelog.enabled: false) — skipping');
    return;
  }

  if (!(gh instanceof GitHubHelper)) {
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- changelog -->',
      '❌ Changelog generation is only supported on GitHub repositories.',
    );
    return;
  }
  const ghApi = gh;

  try {
    if (signal?.aborted) return;

    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- changelog-in-progress -->',
      '📝 **Changelog generation in progress...** Gathering merged PRs since the last release tag. This may take a few minutes.',
    );

    const changelogConfig = config.changelog ?? DEFAULT_CHANGELOG_CONFIG;
    const result = await generateChangelog(ghApi, changelogConfig, undefined, signal);

    if (signal?.aborted) return;

    const body =
      changelogConfig.outputFormat === 'json' ? formatJsonComment(result) : result.markdown;
    await gh.postOrUpdateComment(issueNumber, '<!-- changelog -->', body);
    log.info(
      `Posted changelog for #${issueNumber} (${result.entryCount} PR(s), baseline ${result.since})`,
    );

    if (changelogConfig.createPR && result.entryCount > 0) {
      await createChangelogPR(ghApi, issueNumber, repo, config, result, tempDir, gitEnv, signal);
    }
  } catch (err) {
    log.error(
      `Changelog generation failed for #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- changelog-error -->',
      `❌ **Changelog generation failed**: ${sanitizeErrorMessage(err)}`,
    );
  }
}

/**
 * Wrap the JSON changelog output in a comment-friendly fenced block.
 * @param result - Changelog generation result.
 * @returns A markdown comment body containing the JSON entries.
 */
function formatJsonComment(result: ChangelogResult): string {
  return [
    `### Changelog (${result.entryCount} PR(s) since ${result.since.slice(0, 10)})`,
    '',
    '```json',
    result.json,
    '```',
  ].join('\n');
}

/**
 * Open a release-prep PR that prepends the generated changelog entry to the
 * configured changelog file. Creates a `changelog/<version>` branch from the
 * default branch, writes the file, commits, pushes with `--force-with-lease`,
 * and calls `gh.createPR`. Re-runs push the new entry onto the existing branch
 * and reuse the previously-created PR (mirroring the docs flow).
 *
 * @param gh - GitHubHelper instance.
 * @param issueNumber - PR/issue number that triggered the command.
 * @param repo - Repository string (owner/repo).
 * @param config - Agent configuration.
 * @param result - Changelog generation result.
 * @param tempDir - Temporary working directory containing the cloned repo.
 * @param gitEnv - Git environment variables for authenticated commands.
 * @param signal - Optional abort signal.
 */
async function createChangelogPR(
  gh: GitHubHelper,
  issueNumber: number,
  repo: string,
  config: AgentConfig,
  result: ChangelogResult,
  tempDir: string,
  gitEnv?: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const log = new Logger('Command:Changelog', { repo, prNumber: issueNumber });
  const changelogConfig: ChangelogConfig = config.changelog ?? DEFAULT_CHANGELOG_CONFIG;
  const gitOpts: ExecGitOptions = {
    cwd: tempDir,
    timeout: 120_000,
    ...(gitEnv ? { env: gitEnv } : {}),
    ...(signal ? { signal } : {}),
  };

  const version = result.tag ?? `release-${result.since.slice(0, 10)}`;
  const branchName = `${changelogConfig.prBranchPrefix}/${version}`;
  validateRefName(branchName);

  try {
    try {
      await execGit(['fetch', 'origin'], gitOpts);
      // The shallow clone is single-branch: `fetch origin` only updates the
      // default branch. Fetch the changelog branch into its remote-tracking ref
      // so existing-branch detection and checkout below can reference it.
      await execGit(
        ['fetch', 'origin', `+${branchName}:refs/remotes/origin/${branchName}`],
        gitOpts,
      );
    } catch (err) {
      log.warn(
        `Git fetch failed: ${err instanceof Error ? err.message : String(err)} — continuing with local state`,
      );
    }

    let branchExists = false;
    try {
      await execGit(['rev-parse', '--verify', `origin/${branchName}`], gitOpts);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    const defaultBranch = await gh.getDefaultBranch();

    if (signal?.aborted) return;

    if (branchExists) {
      await execGit(['checkout', '-B', branchName, `origin/${branchName}`], gitOpts);
      log.info(`Checked out existing branch ${branchName}`);
      // A depth-1 clone has no merge-base between the existing branch tip and
      // the updated default branch; deepen so `pull --rebase` works.
      await execGit(['fetch', '--unshallow', 'origin'], gitOpts);
      await execGit(['pull', '--rebase', 'origin', defaultBranch], gitOpts);
    } else {
      await execGit(['checkout', '-b', branchName, `origin/${defaultBranch}`], gitOpts);
      log.info(`Created branch ${branchName} from ${defaultBranch}`);
    }

    const changelogPath = path.join(tempDir, changelogConfig.filePath);
    const existingContent = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf-8') : null;
    writeFileSync(
      changelogPath,
      buildChangelogFileContent(result.markdown, existingContent),
      'utf-8',
    );

    await execGit(['add', '-A'], gitOpts);
    await execGit(['commit', '-m', `chore(release): update changelog for ${version}`], gitOpts);

    try {
      await execGit(['push', 'origin', branchName, '--force-with-lease'], gitOpts);
    } catch (err) {
      log.error(`Git push failed: ${sanitizeErrorMessage(err)}`);
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- changelog-error -->',
        `❌ Changelog push failed: ${sanitizeErrorMessage(err)}`,
      );
      return;
    }

    if (signal?.aborted) return;

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
      log.info(`Created changelog PR #${newPR.number}: ${newPR.url}`);
      try {
        await gh.addLabels(newPR.number, ['changelog']);
      } catch (err) {
        log.warn(
          `Failed to label changelog PR #${newPR.number}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- changelog-pr-link -->',
          `📝 Changelog PR created: ${newPR.url}`,
        );
      } catch (err) {
        log.warn(
          `Failed to post changelog PR link comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    // A re-run of /changelog pushes new entries to the existing branch before we
    // reach this point, so createPR fails because a PR already exists for that
    // branch. Reuse the previously-linked changelog PR instead of erroring.
    const existingPR = await findExistingChangelogPR(gh, issueNumber);
    if (existingPR) {
      log.info(`Reusing existing changelog PR #${existingPR.number}: ${existingPR.url}`);
      try {
        await gh.addLabels(existingPR.number, ['changelog']);
      } catch (err) {
        log.warn(
          `Failed to label changelog PR #${existingPR.number}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- changelog-pr-link -->',
          `📝 Changelog PR: ${existingPR.url}`,
        );
      } catch (err) {
        log.warn(
          `Failed to post changelog PR link comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    log.error('Failed to create PR via GitHub API');
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- changelog-error -->',
      `❌ Failed to create changelog PR from branch \`${branchName}\`. A PR may already exist from this branch or the API rejected the request.`,
    );
  } catch (err) {
    log.error(
      `Changelog PR creation failed for #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- changelog-error -->',
      `❌ **Changelog PR creation failed**: ${sanitizeErrorMessage(err)}`,
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

/**
 * Find a previously-created changelog PR by scanning the source PR's comments
 * for the `<!-- changelog-pr-link -->` marker.
 * @param gh - GitHubHelper instance.
 * @param issueNumber - PR/issue number that triggered the command.
 * @returns The existing changelog PR number/URL, or null.
 */
async function findExistingChangelogPR(
  gh: GitHubHelper,
  issueNumber: number,
): Promise<{ number: number; url: string } | null> {
  try {
    const issue = await gh.getIssue(issueNumber);
    for (const comment of issue.comments) {
      if (comment.body?.startsWith('<!-- changelog-pr-link -->')) {
        const match = comment.body.match(/(https:\/\/github\.com\/[^\s)]+\/pull\/(\d+))/);
        if (match) {
          return { number: Number.parseInt(match[2], 10), url: match[1] };
        }
      }
    }
  } catch (err) {
    logger.debug(
      `Failed to find existing changelog PR for issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}
