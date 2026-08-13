import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type {
  AgentConfig,
  EventBus,
  FixResult,
  PRContext,
  PlatformAdapter,
  PreviousFindingIteration,
  ReviewResult,
} from '@opencode-pr-agent/lib';
import {
  type CheckExecution,
  DEFAULT_ALLOWLIST,
  FIX_MARKER,
  GitHubHelper,
  GitLabAdapter,
  type IterationRecord,
  Logger,
  REVIEW_MARKER,
  ReviewEngine,
  buildAutofixPRBody,
  buildAutofixStatusBody,
  buildFixBody,
  buildReadyBody,
  configureGit,
  parseRunChecksCommands,
  resolveFixedComments,
  validateRefName,
} from '@opencode-pr-agent/lib';
import { mergeRepoConfig } from '../utils/config.js';
import { execGit } from '../utils/git.js';
import type { ExecGitOptions } from '../utils/git.js';

/**
 * Options for {@link handleAutofixLoop}. A single options object (instead of a
 * growing positional parameter list) keeps call sites self-documenting and
 * type-checked when optional fields are added or reordered.
 */
export interface AutofixLoopOptions {
  /** The PR number to review/fix. */
  prNumber: number;
  /** Repository string (owner/repo). */
  repo: string;
  /** GitHub authentication token. */
  token: string;
  /** Agent configuration. */
  config: AgentConfig;
  /** Optional verification command to run after each fix. */
  runChecksAfterFix?: string;
  /** Optional temporary working directory with cloned repo. */
  tempDir?: string;
  /** Optional Git environment variables (for auth). */
  initialGitEnv?: Record<string, string>;
  /** Optional list of allowed check commands. */
  checkAllowlist?: string[];
  /** Optional abort signal. */
  signal?: AbortSignal;
  /** Optional event bus for publishing pipeline events. */
  eventBus?: EventBus;
  /** Optional correlation ID for tracing this request. */
  correlationId?: string;
}

/**
 * Run the complete review-fix loop on a PR from the Probot app context.
 * Iterates up to config.maxIterations: reviews, applies fixes, runs
 * optional verification commands, and posts status comments.
 * @param options - Options controlling the review-fix loop.
 */
export async function handleAutofixLoop(options: AutofixLoopOptions): Promise<void> {
  const {
    prNumber,
    repo,
    token,
    config,
    runChecksAfterFix,
    tempDir,
    initialGitEnv,
    checkAllowlist,
    signal,
    eventBus,
    correlationId,
  } = options;
  if (signal?.aborted) return;
  const logger = new Logger('Autofix', { prNumber, repo, correlationId });
  logger.info(`Starting autofix loop for PR #${prNumber} in ${repo}`);

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new ReviewEngine(
    mergeRepoConfig(config, tempDir),
    gh,
    undefined,
    eventBus,
    repo,
    correlationId,
  );
  const history: IterationRecord[] = [];
  const previousFindings: PreviousFindingIteration[] = [];
  let approved = false;

  let gitEnv = initialGitEnv;
  let ownTempDir: string | undefined;
  let workingDir = tempDir;
  if (!gitEnv && workingDir) {
    gitEnv = configureGit(
      'opencode-pr-agent[bot]',
      'opencode-pr-agent[bot]@users.noreply.github.com',
      token,
      workingDir,
    );
  } else if (!gitEnv) {
    ownTempDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-autofix-'));
    workingDir = ownTempDir;
    gitEnv = configureGit(
      'opencode-pr-agent[bot]',
      'opencode-pr-agent[bot]@users.noreply.github.com',
      token,
      workingDir,
    );
  }
  try {
    for (let i = 0; i < config.maxIterations; i++) {
      let verificationPassed = false;
      logger.info(`=== Autofix iteration ${i + 1}/${config.maxIterations} ===`);

      let pr: PRContext;
      try {
        pr = await gh.getMR(prNumber);
      } catch (err) {
        logger.error(
          `Failed to get PR in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
        break;
      }

      let previousBotComments:
        | Array<{ file: string; line: number | null; body: string; commentId: number }>
        | undefined;
      try {
        const botThreads = await gh.getBotReviewThreads(prNumber);
        previousBotComments = botThreads
          .filter((t) => !t.isResolved)
          .map((t) => ({
            file: t.firstComment.filePath,
            line: t.firstComment.lineNumber,
            body: t.firstComment.body,
            commentId: t.firstComment.databaseId,
          }));
      } catch (err) {
        logger.warn(
          `Could not fetch previous bot comments: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const reviewWorkingDir = workingDir || process.cwd();
      let result: ReviewResult;
      try {
        result = await engine.reviewPR(
          pr,
          i,
          undefined,
          undefined,
          undefined,
          previousFindings,
          reviewWorkingDir,
          undefined,
          previousBotComments,
          undefined,
          { forceReview: true },
        );
      } catch (err) {
        logger.error(
          `Review engine failed in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
        break;
      }

      if (result.skipped) {
        // forceReview was set, so a skip should not normally happen; guard
        // defensively so a dedup short-circuit never aborts the fix loop.
        logger.info(`Review deduplicated in iteration ${i + 1} — continuing`);
        continue;
      }

      if (!result.summary && result.issues.length === 0 && result.strengths.length === 0) {
        logger.error(`Review returned empty result in iteration ${i + 1}`);
        break;
      }

      if (i > 0 && previousFindings.length > 0) {
        await resolveFixedComments(gh, prNumber, previousFindings, result.issues, logger);
      }

      let currentCommentIds:
        | Array<{ file: string; line: number; commentId: number; nodeId?: string }>
        | undefined;
      try {
        const reviewResult = await gh.postReview(
          prNumber,
          pr.headSha,
          result,
          config.review.inline,
        );
        if (reviewResult.commentIds) {
          currentCommentIds = reviewResult.commentIds;
        }
      } catch (err) {
        logger.warn(`Failed to post review comments: ${err instanceof Error ? err.message : err}`);
      }

      const entry: IterationRecord = {
        iteration: i + 1,
        status: 'approved',
        summary: result.summary,
        critical: result.stats.critical,
        important: result.stats.important,
        minor: result.stats.minor,
      };

      const isApproved =
        result.verdict.ready && result.stats.critical === 0 && result.stats.important === 0;

      if (isApproved) {
        approved = true;
        entry.status = 'approved';
        history.push(entry);

        try {
          await gh.setLabels(prNumber, ['autofix:ready'], ['autofix', 'autofix:needs-fix']);
        } catch (err) {
          logger.error(`Failed to set labels: ${err instanceof Error ? err.message : err}`);
        }
        try {
          await gh.createComment(prNumber, buildReadyBody(history, prNumber));
        } catch (err) {
          logger.error(
            `Failed to post ready-to-merge comment: ${err instanceof Error ? err.message : err}`,
          );
        }
        logger.info('Posted ready-to-merge notification');
        break;
      }

      entry.status = 'needs-fix';
      history.push(entry);
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_MARKER,
          buildAutofixStatusBody(history, config.maxIterations, 'reviewing', result),
        );
      } catch (err) {
        logger.error(
          `Failed to post review comment in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
      }

      let contextMd = `## PR #${prNumber}\n\n${pr.body}`;
      if (pr.linkedIssue) {
        try {
          const issue = await gh.getIssue(pr.linkedIssue);
          contextMd += `\n\n## Issue #${pr.linkedIssue}\n\n${issue.body}`;
        } catch {
          /* skip */
        }
      }

      contextMd += `\n\n## Review Feedback (Iteration ${i})\n\n`;
      contextMd += `Summary: ${result.summary}\n`;
      contextMd += `Verdict: ${result.verdict.ready ? 'READY' : 'NEEDS FIXES'} — ${result.verdict.reasoning}\n\n`;
      for (const issue of result.issues) {
        contextMd += `- [${issue.severity.toUpperCase()}] ${issue.file}:${issue.line} — ${issue.message}`;
        if (issue.suggestion) contextMd += `\n  > Fix: ${issue.suggestion}`;
        contextMd += '\n';
      }

      const gitOpts: ExecGitOptions = workingDir
        ? { cwd: workingDir, ...(gitEnv ? { env: gitEnv } : {}), ...(signal ? { signal } : {}) }
        : {};
      let fixResult: FixResult | undefined;
      try {
        fixResult = await engine.runFix(
          prNumber,
          i,
          contextMd,
          pr,
          undefined,
          undefined,
          undefined,
          reviewWorkingDir,
        );
      } catch (err) {
        logger.error(
          `Fix engine failed in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
        break;
      }

      if (fixResult?.stuck) {
        const stuckBody = [
          '🛑 **Fix Agent Stuck**',
          '',
          fixResult.stuckReason ||
            'The fix agent could not determine how to address the remaining issues.',
          '',
          'Please provide additional context or manually apply the fix for the items listed above.',
        ].join('\n');
        try {
          await gh.postOrUpdateComment(prNumber, '<!-- autofix-stuck -->', stuckBody);
        } catch {
          /* ignore */
        }
        logger.info(`Fix agent reported stuck — stopping loop for PR #${prNumber}`);
        break;
      }

      if (!fixResult || !fixResult.changesMade) {
        history[history.length - 1].status = 'no-changes';
        try {
          await gh.postOrUpdateComment(
            prNumber,
            REVIEW_MARKER,
            buildAutofixStatusBody(history, config.maxIterations, 'no-changes', result),
          );
        } catch (err) {
          logger.error(
            `Failed to post no-changes comment: ${err instanceof Error ? err.message : err}`,
          );
        }
        logger.info('Fix agent made no changes — stopping loop');
        break;
      }

      history[history.length - 1].status = 'fix-applied';
      history[history.length - 1].filesChanged = fixResult.filesChanged;
      history[history.length - 1].commitMessage =
        `fix: address review feedback (iteration ${i + 1}) [skip ci]`;

      try {
        await execGit(['add', '-A'], gitOpts);
        await execGit(
          ['commit', '-m', `fix: address review feedback (iteration ${i + 1}) [skip ci]`],
          gitOpts,
        );
        validateRefName(pr.headRef);
        await execGit(['push', 'origin', pr.headRef], gitOpts);
        previousFindings.push({
          iteration: i + 1,
          issues: result.issues,
          fixSummary: fixResult.summary,
          filesChanged: fixResult.filesChanged,
          headSha: pr.headSha,
          commentIds: currentCommentIds?.map((c) => ({
            file: c.file,
            line: c.line,
            commentId: c.commentId,
            nodeId: c.nodeId,
          })),
        });
      } catch (err) {
        logger.error(
          `Git operations failed in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
        try {
          await gh.postOrUpdateComment(
            prNumber,
            REVIEW_MARKER,
            buildAutofixStatusBody(history, config.maxIterations, 'reviewing', result),
          );
        } catch (postErr) {
          logger.error(
            `Failed to post recovery comment after git failure: ${postErr instanceof Error ? postErr.message : postErr}`,
          );
        }
        break;
      }

      if (runChecksAfterFix) {
        logger.info('Running verification commands...');
        let steps: CheckExecution[];
        try {
          steps = parseRunChecksCommands(runChecksAfterFix, checkAllowlist ?? DEFAULT_ALLOWLIST);
        } catch (err) {
          logger.warn(
            `Verification command rejected: ${err instanceof Error ? err.message : String(err)}`,
          );
          steps = [];
        }

        if (steps.length > 0) {
          // The fix workspace is a fresh clone with no dependencies, so the
          // verification commands (pnpm build/typecheck/lint) cannot run.
          // Install dependencies once per iteration before checking.
          const baseCwd = workingDir ?? process.cwd();
          const execOpts = {
            encoding: 'utf-8' as const,
            stdio: 'pipe' as const,
            timeout: 300_000,
          };
          try {
            logger.info('Installing workspace dependencies before verification...');
            const installEnv = {
              ...process.env,
              ...(gitEnv ? { GIT_ASKPASS: 'echo', GIT_TERMINAL_PROMPT: '0' } : {}),
            };
            let installOk = false;
            if (existsSync(path.join(baseCwd, 'pnpm-lock.yaml'))) {
              const lockfile = readFileSync(path.join(baseCwd, 'pnpm-lock.yaml'), 'utf-8');
              const installCmd = lockfile.includes('lockfileVersion: 9')
                ? ['install', '--frozen-lockfile']
                : ['install'];
              execFileSync('pnpm', installCmd, {
                ...execOpts,
                cwd: baseCwd,
                env: installEnv,
                stdio: 'inherit',
              });
              installOk = true;
            } else if (existsSync(path.join(baseCwd, 'package-lock.json'))) {
              execFileSync('npm', ['ci'], {
                ...execOpts,
                cwd: baseCwd,
                env: installEnv,
                stdio: 'inherit',
              });
              installOk = true;
            }
            if (!installOk) {
              logger.warn('No lockfile found — skipping dependency install before verification');
            }
          } catch (installErr) {
            logger.warn(
              `Dependency install failed before verification: ${
                installErr instanceof Error ? installErr.message : String(installErr)
              }`,
            );
          }

          const maxVerificationRetries = 2;
          for (let v = 0; v <= maxVerificationRetries; v++) {
            let checkOutput = '';
            try {
              for (const step of steps) {
                const stdout = execFileSync(step.program, step.args, {
                  ...execOpts,
                  cwd: step.cwd ? path.resolve(baseCwd, step.cwd) : baseCwd,
                });
                checkOutput += stdout;
              }
              verificationPassed = true;
              logger.info('Verification passed');
              break;
            } catch (err) {
              const errWithStderr =
                typeof err === 'object' && err !== null
                  ? (err as { stderr?: Buffer | string })
                  : null;
              const stderr =
                typeof errWithStderr?.stderr === 'string' || Buffer.isBuffer(errWithStderr?.stderr)
                  ? errWithStderr.stderr.toString()
                  : '';
              const message = err instanceof Error ? err.message : String(err);
              checkOutput += message + '\n' + stderr;
              logger.warn(
                `Verification failed (attempt ${v + 1}/${maxVerificationRetries + 1}): ${message}`,
              );

              if (v < maxVerificationRetries) {
                logger.info(
                  `Feeding verification error to fix engine (retry ${v + 1}/${maxVerificationRetries})...`,
                );
                try {
                  const freshPr = await gh.getMR(prNumber);
                  const retryResult = await engine.runFix(
                    prNumber,
                    i,
                    contextMd,
                    freshPr,
                    undefined,
                    result.issues,
                    checkOutput,
                    reviewWorkingDir,
                  );

                  if (retryResult?.changesMade) {
                    await execGit(['add', '-A'], gitOpts);
                    await execGit(
                      ['commit', '-m', `fix: verification errors (attempt ${v + 1}) [skip ci]`],
                      gitOpts,
                    );
                    validateRefName(pr.headRef);
                    await execGit(['push', 'origin', pr.headRef], gitOpts);
                  } else {
                    logger.info('Fix agent made no changes to address verification errors');
                    break;
                  }
                } catch (innerErr) {
                  logger.error(
                    `Verification retry failed: ${innerErr instanceof Error ? innerErr.message : innerErr}`,
                  );
                  break;
                }
              }
            }
          }
        }
      }

      if (fixResult.summary) {
        try {
          const updatedBody = buildAutofixPRBody({
            issueNumber: pr.linkedIssue ?? undefined,
            issueTitle: pr.title,
            fixSummary: fixResult.summary,
            filesChanged: fixResult.filesChanged ?? [],
            branchName: pr.headRef,
            hasTests: verificationPassed,
          });
          await gh.updateMR(prNumber, { body: updatedBody });
          logger.info(`Updated PR #${prNumber} description with latest fix summary`);
        } catch (updateErr) {
          logger.warn(
            `Could not update PR description: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
          );
        }
      }

      try {
        await gh.postOrUpdateComment(prNumber, FIX_MARKER, buildFixBody(history));
      } catch (err) {
        logger.error(`Failed to post fix comment: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (!approved) {
      logger.info(
        `Loop ended without approval for PR #${prNumber} (reached iteration ${config.maxIterations})`,
      );
      try {
        await gh.setLabels(
          prNumber,
          ['autofix:needs-manual-review'],
          ['autofix', 'autofix:needs-fix'],
        );
      } catch (err) {
        logger.error(
          `Failed to set manual review labels: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_MARKER,
          buildAutofixStatusBody(history, config.maxIterations, 'max-iterations'),
        );
      } catch (err) {
        logger.error(
          `Failed to post max iterations comment: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } finally {
    await engine.cleanup();
    if (ownTempDir) {
      try {
        rmSync(ownTempDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}
