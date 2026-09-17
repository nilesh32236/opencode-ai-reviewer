import type {
  AgentConfig,
  DocStyle,
  EventBus,
  ParsedCommand,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import {
  Logger,
  ReviewEngine,
  buildDocsPRBody,
  isDocStyle,
  sanitizeErrorMessage,
  validateRefName,
} from '@opencode-pr-agent/lib';
import { execGit } from '../utils/git.js';
import type { ExecGitOptions } from '../utils/git.js';
import { isAbortError, isValidRepoSlug } from './command-helpers.js';

/**
 * Handle a docs command: generate documentation for the code changed in a PR
 * and open a dedicated documentation PR from a `docs/issue-N` branch (mirrors
 * the autofix flow — the source PR's branch is left untouched). Posts
 * in-progress, no-changes, docs-PR-link, and error comments to the source PR.
 * @param gh - Platform adapter.
 * @param issueNumber - The PR number to document.
 * @param repo - Repository string (owner/repo).
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory containing the cloned repo.
 * @param gitEnv - Git environment variables for authenticated git commands.
 * @param signal - Optional abort signal.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 * @param parsed - Optional parsed command (for flags like --style=tsdoc).
 * @returns A promise that resolves once docs generation, branch setup, and PR
 * creation (or an error comment) complete.
 */
export async function handleDocsCommand(
  gh: PlatformAdapter,
  issueNumber: number,
  repo: string,
  config: AgentConfig,
  tempDir: string,
  gitEnv?: Record<string, string>,
  signal?: AbortSignal,
  eventBus?: EventBus,
  correlationId?: string,
  parsed?: ParsedCommand,
): Promise<void> {
  const logger = new Logger('Command:Docs', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Docs triggered for PR #${issueNumber}`);

  const gitOpts: ExecGitOptions = {
    cwd: tempDir,
    timeout: 120_000,
    ...(gitEnv ? { env: gitEnv } : {}),
    ...(signal ? { signal } : {}),
  };
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);
  const branchName = `docs/issue-${issueNumber}`;
  validateRefName(branchName);

  try {
    if (signal?.aborted) return;

    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- docs-in-progress -->',
      '📝 **Docs generation in progress...** The docs agent is identifying changed code that lacks documentation and generating comments. This may take a few minutes.',
    );

    try {
      await execGit(['fetch', 'origin'], gitOpts);
      // The shallow clone is single-branch: `fetch origin` only updates the
      // default branch. Fetch the docs branch into its remote-tracking ref so
      // existing-branch detection and checkout below can reference it.
      await execGit(
        ['fetch', 'origin', `+${branchName}:refs/remotes/origin/${branchName}`],
        gitOpts,
      );
    } catch (err) {
      logger.warn(
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
    validateRefName(defaultBranch);
    // Base the docs branch on the source PR's head so the changed code the PR
    // adds or modifies is on disk before the docs engine runs. Creating it from
    // the default branch would document pre-PR revisions and miss newly-added
    // files entirely. The source PR's own branch is left untouched.
    const pr = await gh.getMR(issueNumber);
    if (pr.headRef) {
      validateRefName(pr.headRef);
    }
    const baseRef = pr.headRef || defaultBranch;

    // Fork-backed PRs keep the head branch on the fork, not on origin. Resolve
    // the head repo (when it differs from the target repo) and fetch the head
    // branch from that remote so the checkout/rebase below references a real
    // ref instead of assuming `origin/<headRef>`.
    let forkRemote: string | undefined;
    if (pr.headRepoFullName && pr.headRepoFullName !== repo) {
      if (!isValidRepoSlug(pr.headRepoFullName)) {
        logger.warn(
          `Skipping fork fetch — invalid head repo slug "${pr.headRepoFullName}" — falling back to origin`,
        );
      } else {
        try {
          await execGit(
            ['remote', 'add', 'fork', `https://github.com/${pr.headRepoFullName}.git`],
            gitOpts,
          );
          await execGit(['fetch', 'fork', baseRef], gitOpts);
          forkRemote = 'fork';
          logger.info(`Fetched docs base branch ${baseRef} from fork ${pr.headRepoFullName}`);
        } catch (err) {
          logger.warn(
            `Could not fetch docs base branch from fork ${pr.headRepoFullName}: ${err instanceof Error ? err.message : String(err)} — falling back to origin`,
          );
        }
      }
    }

    if (signal?.aborted) return;

    // Same-repository PR head branches are not present in the single-branch
    // shallow clone; fetch the source PR head into its remote-tracking ref so
    // the new-branch checkout below can reference `origin/<baseRef>`.
    if (!forkRemote) {
      try {
        await execGit(['fetch', 'origin', `+${baseRef}:refs/remotes/origin/${baseRef}`], gitOpts);
      } catch (err) {
        logger.warn(
          `Could not fetch docs base branch ${baseRef} from origin: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (branchExists) {
      await execGit(['checkout', '-B', branchName, `origin/${branchName}`], gitOpts);
      logger.info(`Checked out existing branch ${branchName}`);
      // A depth-1 clone has no merge-base between the existing branch tip and
      // the updated base; deepen so `pull --rebase` can compute the merge-base
      // instead of treating both boundary commits as roots.
      await execGit(['fetch', '--unshallow', 'origin'], gitOpts);
      if (forkRemote) {
        await execGit(['fetch', '--unshallow', forkRemote], gitOpts);
      }
      await execGit(['pull', '--rebase', forkRemote ?? 'origin', baseRef], gitOpts);
    } else {
      const startRef = forkRemote ? `${forkRemote}/${baseRef}` : `origin/${baseRef}`;
      validateRefName(startRef);
      await execGit(['checkout', '-b', branchName, startRef], gitOpts);
      logger.info(`Created branch ${branchName} from ${startRef}`);
    }

    const contextMarkdown = await gh.gatherContext({ prNumber: issueNumber });

    if (signal?.aborted) return;

    const styleFlag = typeof parsed?.flags?.style === 'string' ? parsed.flags.style : undefined;
    const styleIsValid = styleFlag !== undefined && isDocStyle(styleFlag);
    if (styleFlag !== undefined && !styleIsValid) {
      logger.warn(`Ignoring invalid docs style flag "${styleFlag}" — using configured style`);
    }
    const docStyle: DocStyle | undefined = styleIsValid ? styleFlag : config.docs?.style;
    signal?.throwIfAborted();
    const docsResult = await engine.runDocs(pr, contextMarkdown, tempDir, undefined, docStyle);

    if (signal?.aborted) return;

    if (!docsResult?.changesMade) {
      logger.info('No documentation changes made by docs agent');
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- docs-no-changes -->',
        '🔍 No documentation changes were needed — the changed code is already documented.',
      );
      return;
    }

    await execGit(['add', '-A'], gitOpts);
    await execGit(['commit', '-m', `docs: add API documentation for #${issueNumber}`], gitOpts);

    try {
      await execGit(['push', 'origin', branchName, '--force-with-lease'], gitOpts);
    } catch (err) {
      logger.error(`Git push failed: ${sanitizeErrorMessage(err)}`);
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- docs-error -->',
          `❌ Docs push failed: ${sanitizeErrorMessage(err)}`,
        );
      } catch (commentErr) {
        logger.warn(
          `Failed to post docs push-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
        );
      }
      return;
    }

    if (signal?.aborted) return;

    const prTitle = `[Docs] ${pr.title}`;
    const prBody = buildDocsPRBody({
      prNumber: issueNumber,
      prTitle: pr.title,
      docsSummary: docsResult.summary,
      filesChanged: docsResult.filesChanged ?? [],
      branchName,
      docStyle,
    });

    await gh.ensureLabels(['docs']);

    const newPR = await gh.createPR(prTitle, prBody, branchName, defaultBranch);
    if (newPR) {
      logger.info(`Created docs PR #${newPR.number}: ${newPR.url}`);
      try {
        await gh.addLabels(newPR.number, ['docs']);
      } catch (err) {
        logger.warn(
          `Failed to label docs PR #${newPR.number}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- docs-pr-link -->',
          `📝 Docs PR created: ${newPR.url}`,
        );
      } catch (err) {
        logger.warn(
          `Failed to post docs PR link comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    // A re-run of /docs pushes new changes to the existing docs/issue-N branch
    // before we reach this point, so createPR fails because a PR already exists
    // for that branch. Reuse the previously-linked docs PR instead of reporting
    // an error to the source PR.
    const existingPR = await findExistingDocsPR(gh, issueNumber);
    if (existingPR) {
      logger.info(`Reusing existing docs PR #${existingPR.number}: ${existingPR.url}`);
      try {
        await gh.addLabels(existingPR.number, ['docs']);
      } catch (err) {
        logger.warn(
          `Failed to label docs PR #${existingPR.number}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- docs-pr-link -->',
          `📝 Docs PR: ${existingPR.url}`,
        );
      } catch (err) {
        logger.warn(
          `Failed to post docs PR link comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    logger.error('Failed to create PR via GitHub API');
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- docs-error -->',
        `❌ Failed to create docs PR from branch \`${branchName}\`. A PR may already exist from this branch or the API rejected the request.`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post docs-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  } catch (err) {
    if (isAbortError(err, signal)) {
      logger.info(`Docs aborted for PR #${issueNumber}`);
      return;
    }
    logger.error(
      `Docs PR creation failed for PR #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- docs-error -->',
        `❌ **Docs generation failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post docs-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  } finally {
    try {
      await engine.cleanup();
    } catch (cleanupErr) {
      logger.warn(
        `Engine cleanup failed for docs #${issueNumber}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }
}

/**
 * Find a previously-linked docs PR for an issue by scanning for the
 * docs-PR-link comment.
 * @param gh - Platform adapter.
 * @param issueNumber - The source issue/PR number.
 * @returns The linked PR number and URL, or null when none is found.
 */
async function findExistingDocsPR(
  gh: PlatformAdapter,
  issueNumber: number,
): Promise<{ number: number; url: string } | null> {
  const logger = new Logger('Command', { prNumber: issueNumber });
  try {
    const issue = await gh.getIssue(issueNumber);
    for (const comment of issue.comments) {
      if (comment.body?.startsWith('<!-- docs-pr-link -->')) {
        const match = comment.body.match(/(https:\/\/github\.com\/[^\s)]+\/pull\/(\d+))/);
        if (match) {
          return { number: Number.parseInt(match[2], 10), url: match[1] };
        }
      }
    }
  } catch (err) {
    logger.debug(
      `Failed to find existing docs PR for issue ${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}
