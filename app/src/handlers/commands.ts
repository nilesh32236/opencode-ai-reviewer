import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentConfig, PRContext } from '@opencode-pr-agent/lib';
import {
  GitHubHelper,
  Logger,
  ReviewEngine,
  configureGit,
  sanitizeError,
  sanitizeErrorMessage,
} from '@opencode-pr-agent/lib';
import { handleAudit } from './audit.js';
import { handleAutofixLoop } from './autofix.js';
import { handlePRReview } from './pr-review.js';

export async function handleCommand(
  command: 'fix' | 'review' | 'audit',
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
): Promise<void> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber });
  const gh = new GitHubHelper(token, repo);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-workspace-'));
  const prevCwd = process.cwd();

  try {
    execFileSync(
      'git',
      ['clone', `https://x-access-token:${token}@github.com/${repo}.git`, tempDir],
      { stdio: 'pipe' },
    );

    process.chdir(tempDir);

    switch (command) {
      case 'review': {
        if (await gh.isPR(issueNumber)) {
          await handlePRReview(issueNumber, repo, token, config);
        }
        break;
      }

      case 'fix': {
        const existingPR = await findExistingAutofixPR(gh, issueNumber);
        if (existingPR) {
          await handleAutofixLoop(existingPR, repo, token, config);
        } else {
          const newPR = await createAutofixPR(gh, issueNumber, repo, token, config);
          if (newPR) {
            await handleAutofixLoop(newPR, repo, token, config);
          }
        }
        break;
      }

      case 'audit': {
        await handleAudit(repo, token, config);
        break;
      }
    }
  } catch (err) {
    logger.error(
      `Command ${command} failed for issue ${issueNumber} in ${repo}: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    process.chdir(prevCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function findExistingAutofixPR(
  gh: GitHubHelper,
  issueNumber: number,
): Promise<number | null> {
  const logger = new Logger('Command', { prNumber: issueNumber });
  try {
    const issue = await gh.getIssue(issueNumber);
    let prLink = issue.body?.match(/PR #(\d+)/)?.[1];
    if (!prLink) {
      for (const comment of issue.comments) {
        if (comment.body?.startsWith('<!-- autofix-pr-link -->')) {
          const urlMatch = comment.body.match(/\/pull\/(\d+)/);
          if (urlMatch) {
            prLink = urlMatch[1];
            break;
          }
        }
      }
    }
    if (prLink) return Number.parseInt(prLink, 10);
  } catch (err) {
    logger.debug(
      `Failed to find existing autofix PR for issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}

async function createAutofixPR(
  gh: GitHubHelper,
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
): Promise<number | null> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber });
  logger.info(`Fix triggered for issue #${issueNumber}`);

  configureGit('opencode-pr-agent[bot]', 'opencode-pr-agent[bot]@users.noreply.github.com', token);

  const engine = new ReviewEngine(config, token, repo);
  const branchName = `autofix/issue-${issueNumber}`;

  try {
    try {
      execFileSync('git', ['fetch', 'origin'], { stdio: 'pipe' });
    } catch (err) {
      logger.warn(
        `Git fetch failed: ${err instanceof Error ? err.message : String(err)} — continuing with local state`,
      );
    }

    let branchExists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', `origin/${branchName}`], { stdio: 'pipe' });
      branchExists = true;
    } catch {
      branchExists = false;
    }

    const defaultBranch = await gh.getDefaultBranch();

    if (branchExists) {
      execFileSync('git', ['checkout', '-B', branchName, `origin/${branchName}`]);
      logger.info(`Checked out existing branch ${branchName}`);
      execFileSync('git', ['pull', '--rebase', 'origin', defaultBranch], { stdio: 'pipe' });
    } else {
      execFileSync('git', ['checkout', '-b', branchName, `origin/${defaultBranch}`]);
      logger.info(`Created branch ${branchName} from ${defaultBranch}`);
    }

    const issue = await gh.getIssue(issueNumber);
    const issueContext = await gh.gatherContext({ issueNumber });
    const stubPR: PRContext = {
      number: issueNumber,
      title: issue.title,
      body: issue.body || '',
      headRef: branchName,
      headSha: '',
      baseRef: defaultBranch,
      author: 'opencode-pr-agent[bot]',
      labels: [],
      changedFiles: [],
    };
    const fixResult = await engine.runFix(issueNumber, 0, issueContext, stubPR);

    if (!fixResult?.changesMade) {
      logger.info('No changes made by fix agent');
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-no-changes -->',
        '🔍 No changes were needed — the fix agent found nothing to fix.',
      );
      return null;
    }

    execFileSync('git', ['add', '-A']);
    execFileSync('git', ['commit', '-m', `fix: address issue #${issueNumber}`]);

    try {
      execFileSync('git', ['push', 'origin', branchName, '--force']);
    } catch (err) {
      logger.error(`Git push failed: ${err instanceof Error ? err.message : err}`);
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-error -->',
        `❌ Autofix push failed: ${sanitizeErrorMessage(err)}`,
      );
      return null;
    }

    const prTitle = `[Autofix] ${issue.title}`;
    const prBody = `## Fixes #${issueNumber}\n\n${issue.body}\n\n---\n*Auto-generated by opencode-ai-reviewer*`;

    await gh.ensureLabels(['autofix']);

    const pr = await gh.createPR(prTitle, prBody, branchName, defaultBranch);
    if (pr) {
      logger.info(`Created PR #${pr.number}: ${pr.url}`);
      try {
        await gh.addLabels(pr.number, ['autofix']);
      } catch (err) {
        logger.warn(
          `Failed to label autofix PR #${pr.number}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- autofix-pr-link -->',
          `🔧 Autofix PR created: ${pr.url}`,
        );
      } catch (err) {
        logger.warn(
          `Failed to post autofix PR link comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      return pr.number;
    }

    logger.error('Failed to create PR via GitHub API');
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- autofix-error -->',
      `❌ Failed to create autofix PR from branch \`${branchName}\`. A PR may already exist from this branch or the API rejected the request.`,
    );
    return null;
  } catch (err) {
    logger.error(
      `Autofix PR creation failed for issue #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  } finally {
    await engine.cleanup();
  }
}
