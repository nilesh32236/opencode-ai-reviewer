import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'path';
import type {
  AgentConfig,
  ChangelogConfig,
  ChangelogResult,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import {
  DEFAULT_CHANGELOG_CONFIG,
  GitHubHelper,
  Logger,
  buildChangelogPRBody,
  findLinkedPRByMarker,
  generateChangelog,
  prepareBranchWorkspace,
  pushBranchWithLease,
  sanitizeErrorMessage,
  validateRefName,
} from '@opencode-pr-agent/lib';
import { execGit } from '../utils/git.js';
import type { ExecGitOptions } from '../utils/git.js';

/** Module-scope logger for helper functions that have no per-call context. */
const logger = new Logger('Changelog');

/** Timeout (ms) for git operations when publishing the changelog PR. */
const GIT_TIMEOUT_MS = 120_000;

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
 * Resolve the configured changelog file path inside the scratch workspace,
 * rejecting traversal/absolute values that would write outside tempDir.
 * The value is currently operator-controlled (defaults), but without this
 * containment check a future repo-influenced config could escape the clone.
 * Symlink escapes are also rejected: a symlinked filePath (or a symlinked
 * parent directory inside tempDir) pointing outside the workspace returns
 * null even when the lexical prefix check passes.
 * @param tempDir - Scratch workspace root containing the cloned repo.
 * @param filePath - Configured changelog file path (e.g. CHANGELOG.md).
 * @returns The resolved absolute path, or null when it escapes tempDir.
 */
export function resolveChangelogPath(tempDir: string, filePath: string): string | null {
  if (!filePath || filePath.trim() === '') return null;
  const base = path.resolve(tempDir);
  const resolved = path.resolve(base, filePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  // A symlinked filePath inside tempDir pointing outside still escapes
  // containment — reject it (missing paths cannot be symlinks; skip those).
  try {
    if (lstatSync(resolved).isSymbolicLink()) return null;
  } catch {
    // Not yet created — no symlink to escape through; fall through to the
    // parent-dir realpath check below.
  }
  // A symlinked parent dir inside tempDir could also escape: realpath the
  // nearest existing ancestor and re-verify containment from there.
  let dir = path.dirname(resolved);
  const missing: string[] = [];
  while (!existsSync(dir)) {
    missing.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  const realBase = realpathSync(base);
  const contained = path.join(realpathSync(dir), ...missing);
  if (contained !== realBase && !contained.startsWith(realBase + path.sep)) return null;
  return resolved;
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
    timeout: GIT_TIMEOUT_MS,
    ...(gitEnv ? { env: gitEnv } : {}),
    ...(signal ? { signal } : {}),
  };

  const version = result.tag ?? `release-${result.since.slice(0, 10)}`;
  const branchName = `${changelogConfig.prBranchPrefix}/${version}`;
  validateRefName(branchName);

  try {
    const defaultBranch = await gh.getDefaultBranch();
    validateRefName(defaultBranch);

    if (signal?.aborted) return;

    // Single owner for fetch → checkout → rebase (lib/branch-workspace).
    await prepareBranchWorkspace(execGit, {
      branchName,
      defaultBranch,
      repo,
      cwd: tempDir,
      ...(gitEnv ? { env: gitEnv } : {}),
      ...(signal ? { signal } : {}),
      logger: log,
    });

    const changelogPath = resolveChangelogPath(tempDir, changelogConfig.filePath);
    if (!changelogPath) {
      log.error(
        'Refusing changelog write: configured filePath escapes the workspace: ' +
          String(changelogConfig.filePath),
      );
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- changelog-error -->',
        'Changelog filePath escapes the workspace and was rejected.',
      );
      return;
    }
    const existingContent = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf-8') : null;
    writeFileSync(
      changelogPath,
      buildChangelogFileContent(result.markdown, existingContent),
      'utf-8',
    );

    await execGit(['add', '-A'], gitOpts);
    await execGit(['commit', '-m', `chore(release): update changelog for ${version}`], gitOpts);

    try {
      await pushBranchWithLease(execGit, {
        branchName,
        cwd: tempDir,
        ...(gitEnv ? { env: gitEnv } : {}),
        ...(signal ? { signal } : {}),
      });
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
 * for the `<!-- changelog-pr-link -->` marker (single owner:
 * `lib/src/utils/linked-pr.ts#findLinkedPRByMarker`).
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
    return findLinkedPRByMarker(issue.comments, '<!-- changelog-pr-link -->');
  } catch (err) {
    logger.debug(
      `Failed to find existing changelog PR for issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}
