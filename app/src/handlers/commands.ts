import { execFileSync } from 'child_process';
import type { ExecFileSyncOptions } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type {
  AgentConfig,
  DocStyle,
  EventBus,
  PRContext,
  ParsedCommand,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import {
  GitHubHelper,
  GitLabAdapter,
  Logger,
  ReviewEngine,
  SetupEngine,
  buildAutofixPRBody,
  buildDocsPRBody,
  configureGit,
  isDocStyle,
  markAnalysisReady,
  parseAnalysisPlan,
  postBlockingQuestions,
  sanitizeErrorMessage,
} from '@opencode-pr-agent/lib';
import { isBotLogin } from '../utils/bot.js';
import { handleAudit } from './audit.js';
import { handleAutofixLoop } from './autofix.js';
import { handlePRReview } from './pr-review.js';

/** Module-scope logger for helper functions that have no per-call context. */
const logger = new Logger('Command');

/**
 * Handle a slash command (fix/review/audit/analyze): clone the repo, execute
 * the appropriate handler (PR review, autofix loop, audit, or analyze) in a
 * temp workspace, and clean up.
 * @param command - The command to execute.
 * @param issueNumber - The issue or PR number.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param parsed - Optional parsed command (for flags like --force).
 * @param signal - Optional abort signal
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 */
export async function handleCommand(
  command: 'fix' | 'review' | 'audit' | 'analyze' | 'explain' | 'setup' | 'docs' | 'describe',
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  parsed?: ParsedCommand,
  signal?: AbortSignal,
  eventBus?: EventBus,
  correlationId?: string,
): Promise<void> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber, correlationId });
  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-workspace-'));

  try {
    const gitEnv = configureGit(
      'opencode-pr-agent[bot]',
      'opencode-pr-agent[bot]@users.noreply.github.com',
      token,
      tempDir,
    );

    if (signal?.aborted) return;

    const cloneOpts: ExecFileSyncOptions = {
      stdio: 'pipe',
      timeout: 120_000,
      ...(gitEnv ? { env: { ...process.env, ...gitEnv } } : {}),
    };
    try {
      execFileSync('git', ['clone', `https://github.com/${repo}.git`, tempDir], cloneOpts);
    } catch (err) {
      logger.error(`Git clone failed for ${repo}: ${err instanceof Error ? err.message : err}`);
      if (command === 'setup') {
        // Setup must still produce a diagnostic report even when the repo
        // cannot be cloned (e.g. missing/read-only token): run the checks
        // against the empty temp dir so token-independent checks still run.
        logger.info(
          `Running setup validation against an empty workspace because ${repo} could not be cloned`,
        );
        await handleSetup(issueNumber, repo, token, config, tempDir);
        return;
      }
      throw err;
    }

    switch (command) {
      case 'analyze': {
        await handleAnalyzeCommand(
          issueNumber,
          repo,
          token,
          config,
          tempDir,
          eventBus,
          correlationId,
        );
        break;
      }

      case 'explain': {
        await handleExplainCommand(
          issueNumber,
          repo,
          token,
          config,
          tempDir,
          eventBus,
          correlationId,
        );
        break;
      }

      case 'describe': {
        if (!(await gh.isMR(issueNumber))) {
          logger.info(`Ignoring /describe on #${issueNumber}: not a pull request`);
          break;
        }
        await handleDescribeCommand(
          issueNumber,
          repo,
          token,
          config,
          tempDir,
          eventBus,
          correlationId,
        );
        break;
      }

      case 'review': {
        if (await gh.isMR(issueNumber)) {
          await handlePRReview(
            issueNumber,
            repo,
            token,
            config,
            undefined,
            tempDir,
            undefined,
            eventBus,
            correlationId,
          );
        }
        break;
      }

      case 'fix': {
        if (signal?.aborted) return;
        const force = parsed?.flags?.force === true;
        const isPR = await gh.isMR(issueNumber);
        if (isPR) {
          await handleAutofixLoop({
            prNumber: issueNumber,
            repo,
            token,
            config,
            tempDir,
            initialGitEnv: gitEnv,
            signal,
            eventBus,
            correlationId,
          });
        } else {
          const existingPR = await findExistingAutofixPR(gh, issueNumber);
          if (existingPR) {
            await handleAutofixLoop({
              prNumber: existingPR,
              repo,
              token,
              config,
              tempDir,
              initialGitEnv: gitEnv,
              signal,
              eventBus,
              correlationId,
            });
          } else {
            const newPR = await createAutofixPR(
              gh,
              issueNumber,
              repo,
              config,
              tempDir,
              gitEnv,
              signal,
              force,
              eventBus,
              correlationId,
            );
            if (newPR) {
              await handleAutofixLoop({
                prNumber: newPR,
                repo,
                token,
                config,
                tempDir,
                initialGitEnv: gitEnv,
                signal,
                eventBus,
                correlationId,
              });
            }
          }
        }
        break;
      }

      case 'audit': {
        await handleAudit(
          repo,
          token,
          config,
          undefined,
          undefined,
          tempDir,
          undefined,
          issueNumber,
          eventBus,
          correlationId,
        );
        break;
      }

      case 'docs': {
        if (!(await gh.isMR(issueNumber))) {
          logger.info(`Ignoring /docs on #${issueNumber}: not a pull request`);
          break;
        }
        await handleDocsCommand(
          gh,
          issueNumber,
          repo,
          config,
          tempDir,
          gitEnv,
          signal,
          eventBus,
          correlationId,
          parsed,
        );
        break;
      }

      case 'setup': {
        await handleSetup(issueNumber, repo, token, config, tempDir);
        break;
      }
    }
  } catch (err) {
    logger.error(
      `Command ${command} failed for issue ${issueNumber} in ${repo}: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Handle an analyze command: gather issue context, run the analysis engine,
 * and post the implementation plan as a comment on the issue.
 * @param issueNumber - The issue number to analyze.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 */
export async function handleAnalyzeCommand(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
  eventBus?: EventBus,
  correlationId?: string,
): Promise<void> {
  const logger = new Logger('Command:Analyze', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Analyzing issue #${issueNumber}`);

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);

  try {
    const issueContext = await gh.gatherContext({ issueNumber });

    const planMarkdown = await engine.runAnalyze(issueNumber, issueContext, undefined, tempDir);
    const parsed = parseAnalysisPlan(planMarkdown);

    await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);

    if (parsed.hasBlockingQuestions) {
      await postBlockingQuestions(gh, issueNumber, parsed);
    } else {
      await markAnalysisReady(gh, issueNumber);
    }

    logger.info(`Posted analysis plan for issue #${issueNumber}`);
  } catch (err) {
    logger.error(
      `Failed to analyze issue #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- issue-analysis-error -->',
      `❌ **Analysis Failed**: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await engine.cleanup();
  }
}

/**
 * Handle an explain command: gather PR context, run the explain engine,
 * and post the PR explanation as a comment on the PR.
 * @param issueNumber - The PR number to explain.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 */
export async function handleExplainCommand(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
  eventBus?: EventBus,
  correlationId?: string,
): Promise<void> {
  const logger = new Logger('Command:Explain', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Explaining PR #${issueNumber}`);

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);

  try {
    const pr = await gh.getMR(issueNumber);
    const explanation = await engine.runExplain(pr, tempDir);

    await gh.postOrUpdateComment(issueNumber, '<!-- pr-explanation -->', explanation);

    logger.info(`Posted explanation for PR #${issueNumber}`);
  } catch (err) {
    logger.error(
      `Failed to explain PR #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- pr-explanation-error -->',
      `❌ **Explanation Failed**: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await engine.cleanup();
  }
}

/**
 * Handle a describe command: gather PR context, run the describe engine,
 * and post the generated PR description as a comment on the PR.
 * @param issueNumber - The PR number to describe.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 */
export async function handleDescribeCommand(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
  eventBus?: EventBus,
  correlationId?: string,
): Promise<void> {
  const logger = new Logger('Command:Describe', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Describing PR #${issueNumber}`);

  if (config.describe?.enabled === false) {
    logger.info('PR description generation is disabled (describe.enabled: false) — skipping');
    return;
  }

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);

  try {
    const pr = await gh.getMR(issueNumber);
    const description = await engine.runDescribe(pr, tempDir);

    await gh.postOrUpdateComment(issueNumber, '<!-- pr-description -->', description);

    logger.info(`Posted PR description for PR #${issueNumber}`);
  } catch (err) {
    logger.error(
      `Failed to describe PR #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- pr-description-error -->',
      `❌ **Description Generation Failed**: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await engine.cleanup();
  }
}

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

  const gitOpts: ExecFileSyncOptions = {
    stdio: 'pipe',
    cwd: tempDir,
    timeout: 120_000,
    ...(gitEnv ? { env: { ...process.env, ...gitEnv } } : {}),
  };
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);
  const branchName = `docs/issue-${issueNumber}`;

  try {
    if (signal?.aborted) return;

    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- docs-in-progress -->',
      '📝 **Docs generation in progress...** The docs agent is identifying changed code that lacks documentation and generating comments. This may take a few minutes.',
    );

    try {
      execFileSync('git', ['fetch', 'origin'], gitOpts);
    } catch (err) {
      logger.warn(
        `Git fetch failed: ${err instanceof Error ? err.message : String(err)} — continuing with local state`,
      );
    }

    let branchExists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', `origin/${branchName}`], gitOpts);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    const defaultBranch = await gh.getDefaultBranch();
    // Base the docs branch on the source PR's head so the changed code the PR
    // adds or modifies is on disk before the docs engine runs. Creating it from
    // the default branch would document pre-PR revisions and miss newly-added
    // files entirely. The source PR's own branch is left untouched.
    const pr = await gh.getMR(issueNumber);
    const baseRef = pr.headRef || defaultBranch;

    // Fork-backed PRs keep the head branch on the fork, not on origin. Resolve
    // the head repo (when it differs from the target repo) and fetch the head
    // branch from that remote so the checkout/rebase below references a real
    // ref instead of assuming `origin/<headRef>`.
    let forkRemote: string | undefined;
    if (pr.headRepoFullName && pr.headRepoFullName !== repo) {
      try {
        execFileSync(
          'git',
          ['remote', 'add', 'fork', `https://github.com/${pr.headRepoFullName}.git`],
          gitOpts,
        );
        execFileSync('git', ['fetch', 'fork', baseRef], gitOpts);
        forkRemote = 'fork';
        logger.info(`Fetched docs base branch ${baseRef} from fork ${pr.headRepoFullName}`);
      } catch (err) {
        logger.warn(
          `Could not fetch docs base branch from fork ${pr.headRepoFullName}: ${err instanceof Error ? err.message : String(err)} — falling back to origin`,
        );
      }
    }

    if (signal?.aborted) return;

    if (branchExists) {
      execFileSync('git', ['checkout', '-B', branchName, `origin/${branchName}`], gitOpts);
      logger.info(`Checked out existing branch ${branchName}`);
      execFileSync('git', ['pull', '--rebase', forkRemote ?? 'origin', baseRef], gitOpts);
    } else {
      const startRef = forkRemote ? `${forkRemote}/${baseRef}` : `origin/${baseRef}`;
      execFileSync('git', ['checkout', '-b', branchName, startRef], gitOpts);
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

    execFileSync('git', ['add', '-A'], gitOpts);
    execFileSync(
      'git',
      ['commit', '-m', `docs: add API documentation for #${issueNumber}`],
      gitOpts,
    );

    try {
      execFileSync('git', ['push', 'origin', branchName, '--force-with-lease'], gitOpts);
    } catch (err) {
      logger.error(`Git push failed: ${err instanceof Error ? err.message : err}`);
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- docs-error -->',
        `❌ Docs push failed: ${sanitizeErrorMessage(err)}`,
      );
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
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- docs-error -->',
      `❌ Failed to create docs PR from branch \`${branchName}\`. A PR may already exist from this branch or the API rejected the request.`,
    );
  } catch (err) {
    logger.error(
      `Docs PR creation failed for PR #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- docs-error -->',
      `❌ **Docs generation failed**: ${sanitizeErrorMessage(err)}`,
    );
  } finally {
    await engine.cleanup();
  }
}

/**
 * Handle a setup command: run the pre-flight validation checks against the
 * cloned workspace and post the markdown report as a comment on the issue.
 * @param issueNumber - The issue/PR number that triggered the setup.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory containing the cloned repo.
 */
export async function handleSetup(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
): Promise<void> {
  const logger = new Logger('Command:Setup', { repo, prNumber: issueNumber });
  logger.info(`Running setup validation for issue #${issueNumber}`);

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new SetupEngine(config, {
    workingDirectory: tempDir,
    platform: config.platform,
    githubToken: token,
    repo: config.platform === 'github' ? repo : undefined,
  });

  try {
    const result = await engine.runAll();
    const report = engine.formatReport(result);

    await gh.postOrUpdateComment(issueNumber, '<!-- setup-report -->', report);

    logger.info(
      `Posted setup validation report for issue #${issueNumber} (overall: ${result.overall})`,
    );
  } catch (err) {
    logger.error(
      `Failed to run setup validation for issue #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- setup-report -->',
      `❌ **Setup Validation Failed**: ${sanitizeErrorMessage(err)}`,
    );
  }
}

async function findExistingAutofixPR(
  gh: PlatformAdapter,
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
      `Failed to find existing docs PR for issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}

async function createAutofixPR(
  gh: PlatformAdapter,
  issueNumber: number,
  repo: string,
  config: AgentConfig,
  tempDir: string,
  gitEnv?: Record<string, string>,
  signal?: AbortSignal,
  force = false,
  eventBus?: EventBus,
  correlationId?: string,
): Promise<number | null> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Fix triggered for issue #${issueNumber}`);

  if (signal?.aborted) return null;

  await gh.postOrUpdateComment(
    issueNumber,
    '<!-- autofix-in-progress -->',
    '🤖 **Autofix in progress...** The fix agent is analyzing the codebase and implementing changes. This may take a few minutes.',
  );

  const gitOpts: ExecFileSyncOptions = {
    stdio: 'pipe',
    cwd: tempDir,
    timeout: 120_000,
    ...(gitEnv ? { env: { ...process.env, ...gitEnv } } : {}),
  };
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);
  const branchName = `autofix/issue-${issueNumber}`;

  try {
    try {
      execFileSync('git', ['fetch', 'origin'], gitOpts);
    } catch (err) {
      logger.warn(
        `Git fetch failed: ${err instanceof Error ? err.message : String(err)} — continuing with local state`,
      );
    }

    let branchExists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', `origin/${branchName}`], gitOpts);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    const defaultBranch = await gh.getDefaultBranch();

    if (signal?.aborted) return null;

    if (branchExists) {
      execFileSync('git', ['checkout', '-B', branchName, `origin/${branchName}`], gitOpts);
      logger.info(`Checked out existing branch ${branchName}`);
      execFileSync('git', ['pull', '--rebase', 'origin', defaultBranch], gitOpts);
    } else {
      execFileSync('git', ['checkout', '-b', branchName, `origin/${defaultBranch}`], gitOpts);
      logger.info(`Created branch ${branchName} from ${defaultBranch}`);
    }

    const issue = await gh.getIssue(issueNumber);
    let issueContext = await gh.gatherContext({ issueNumber });

    if (signal?.aborted) return null;

    // Auto-analyze if no implementation plan exists yet
    // gatherContext() strips the marker and replaces it with the header below,
    // so check both.
    const hasPlan =
      issueContext.includes('<!-- issue-analysis-plan -->') ||
      issueContext.includes('### Implementation Plan (from analysis)');
    if (!hasPlan) {
      logger.info('No implementation plan found — running analyze first');
      const planMarkdown = await engine.runAnalyze(issueNumber, issueContext, undefined, tempDir);
      const parsed = parseAnalysisPlan(planMarkdown);
      await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);

      if (parsed.hasBlockingQuestions) {
        if (force) {
          logger.info('Force mode — auto-answering blocking questions');
          await autoAnswerBlockingQuestions(gh, issueNumber, parsed.blockingQuestions);
        } else {
          await postBlockingQuestions(gh, issueNumber, parsed);
          await gh.postOrUpdateComment(
            issueNumber,
            '<!-- autofix-deferred -->',
            [
              '⏸️ **Fix Deferred — Questions Pending**',
              '',
              'I cannot start the fix yet because there are unanswered questions in the analysis.',
              'Please answer the questions above, then comment `/fix` again.',
            ].join('\n'),
          );
          return null;
        }
      } else {
        await markAnalysisReady(gh, issueNumber);
      }

      issueContext = await gh.gatherContext({ issueNumber });
    }

    if (signal?.aborted) return null;

    const hasQuestionsPending = await checkForUnansweredQuestions(gh, issueNumber, issueContext);
    if (hasQuestionsPending) {
      if (force) {
        logger.info('Force mode — auto-answering pending questions from previous analysis');
        const pendingQuestions = await extractBlockingQuestions(gh, issueNumber);
        await autoAnswerBlockingQuestions(gh, issueNumber, pendingQuestions);
      } else {
        logger.info(`Issue #${issueNumber} has unanswered blocking questions — fix deferred`);
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- autofix-deferred -->',
          [
            '⏸️ **Fix Deferred — Questions Pending**',
            '',
            'I cannot start the fix yet because there are unanswered questions in the analysis.',
            'Please answer the questions above, then comment `/fix` again.',
          ].join('\n'),
        );
        return null;
      }
    }

    const qa = buildQAContext(issue.comments);
    if (qa) {
      issueContext += '\n\n' + qa;
    }

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
    const fixResult = await engine.runFix(
      issueNumber,
      0,
      issueContext,
      stubPR,
      undefined,
      undefined,
      undefined,
      tempDir,
    );

    if (signal?.aborted) return null;

    if (!fixResult?.changesMade) {
      logger.info('No changes made by fix agent');
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-no-changes -->',
        '🔍 No changes were needed — the fix agent found nothing to fix.',
      );
      return null;
    }

    execFileSync('git', ['add', '-A'], gitOpts);
    execFileSync('git', ['commit', '-m', `fix: address issue #${issueNumber}`], gitOpts);

    try {
      execFileSync('git', ['push', 'origin', branchName, '--force-with-lease'], gitOpts);
    } catch (err) {
      logger.error(`Git push failed: ${err instanceof Error ? err.message : err}`);
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-error -->',
        `❌ Autofix push failed: ${sanitizeErrorMessage(err)}`,
      );
      return null;
    }

    if (signal?.aborted) return null;

    const prTitle = `[Autofix] ${issue.title}`;
    const prBody = buildAutofixPRBody({
      issueNumber,
      issueTitle: issue.title,
      fixSummary: fixResult.summary,
      filesChanged: fixResult.filesChanged ?? [],
      branchName,
      hasTests: false,
    });

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

async function checkForUnansweredQuestions(
  gh: PlatformAdapter,
  issueNumber: number,
  issueContext: string,
): Promise<boolean> {
  if (!issueContext.includes('<!-- issue-analysis-questions -->')) {
    return false;
  }
  try {
    const issue = await gh.getIssue(issueNumber);
    if (!issue.labels.includes('analysis:needs-input')) {
      return false;
    }
    const questionsCommentIdx = issue.comments.findIndex((c) =>
      c.body.startsWith('<!-- issue-analysis-questions -->'),
    );
    if (questionsCommentIdx === -1) return true;

    const repliesAfter = issue.comments
      .slice(questionsCommentIdx + 1)
      .filter((c) => !isBotLogin(c.author));

    return repliesAfter.length === 0;
  } catch (err) {
    logger.warn(
      `Failed to check unanswered questions for #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

function buildQAContext(comments: Array<{ author: string; body: string }>): string {
  const questionsIdx = comments.findIndex((c) =>
    c.body.startsWith('<!-- issue-analysis-questions -->'),
  );
  if (questionsIdx === -1) return '';

  const answers = comments.slice(questionsIdx + 1).filter((c) => !isBotLogin(c.author));
  if (answers.length === 0) return '';

  const lines = ['### Q&A Context (from issue discussion)'];
  for (const answer of answers) {
    lines.push(`**@${answer.author}:** ${answer.body}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Auto-answer blocking questions on an issue when --force is used.
 * Posts a comment with default answers and swaps labels to analysis:ready.
 * @param gh - Platform adapter
 * @param issueNumber - Issue number
 * @param questions - Blocking questions to answer
 */
async function autoAnswerBlockingQuestions(
  gh: PlatformAdapter,
  issueNumber: number,
  questions: string[],
): Promise<void> {
  const answers = questions.map(
    (q, i) => `**Q${i + 1}:** ${q}\n\n**A${i + 1}:** Yes, proceed with the recommended approach.`,
  );

  const body = [
    '<!-- autofix-force-answers -->',
    '## ✅ Auto-Answers (Force Mode)',
    '',
    'The `/fix --force` command was used. Automatically answering the following questions to proceed:',
    '',
    ...answers,
    '',
    '---',
    '*Proceeding with implementation.*',
  ].join('\n');

  await gh.postOrUpdateComment(issueNumber, '<!-- autofix-force-answers -->', body);
  await gh.setLabels(issueNumber, ['analysis:ready'], ['analysis:needs-input']);
}

/**
 * Extract blocking questions from the issue's questions comment.
 * @param gh - Platform adapter
 * @param issueNumber - Issue number
 * @returns Array of blocking question strings
 */
async function extractBlockingQuestions(
  gh: PlatformAdapter,
  issueNumber: number,
): Promise<string[]> {
  try {
    const issue = await gh.getIssue(issueNumber);
    const questionsComment = issue.comments.find((c) =>
      c.body.startsWith('<!-- issue-analysis-questions -->'),
    );
    if (!questionsComment) return [];

    const questions: string[] = [];
    const qRegex = /(?:\*\*Q\d+:\*\*|\*\*Question \d+:\*\*)\s*(.+?)(?=\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = qRegex.exec(questionsComment.body)) !== null) {
      const qText = match[1]?.trim();
      if (qText) questions.push(qText);
    }
    return questions;
  } catch {
    return [];
  }
}
