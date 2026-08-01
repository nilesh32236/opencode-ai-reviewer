import { execFileSync } from 'child_process';
import type { ExecFileSyncOptions } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
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
  DEFAULT_ALLOWLIST,
  FIX_MARKER,
  GitHubHelper,
  GitLabAdapter,
  type IterationRecord,
  Logger,
  REVIEW_MARKER,
  ReviewEngine,
  buildAutofixPRBody,
  buildFixBody,
  buildReadyBody,
  buildReviewBody,
  configureGit,
  resolveFixedComments,
  validateRefName,
  validateRunChecksCommand,
} from '@opencode-pr-agent/lib';

/**
 * Run the complete review-fix loop on a PR from the Probot app context.
 * Iterates up to config.maxIterations: reviews, applies fixes, runs
 * optional verification commands, and posts status comments.
 * @param prNumber - The PR number.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param runChecksAfterFix - Optional verification command to run after each fix.
 * @param tempDir - Optional temporary working directory with cloned repo.
 * @param initialGitEnv - Optional Git environment variables (for auth).
 * @param checkAllowlist - Optional list of allowed check commands.
 * @param signal - Optional abort signal
 * @param eventBus - Optional event bus for publishing pipeline events.
 */
export async function handleAutofixLoop(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  runChecksAfterFix?: string,
  tempDir?: string,
  initialGitEnv?: Record<string, string>,
  checkAllowlist?: string[],
  signal?: AbortSignal,
  eventBus?: EventBus,
): Promise<void> {
  if (signal?.aborted) return;
  const logger = new Logger('Autofix', { prNumber, repo });
  logger.info(`Starting autofix loop for PR #${prNumber} in ${repo}`);

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo);
  const history: IterationRecord[] = [];
  const previousFindings: PreviousFindingIteration[] = [];
  let approved = false;
  let verificationPassed = false;

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
          .filter((t) => !t.isResolved && t.firstComment)
          .map((t) => ({
            file: t.firstComment!.filePath,
            line: t.firstComment!.lineNumber,
            body: t.firstComment!.body,
            commentId: t.firstComment!.databaseId,
          }));
      } catch (err) {
        logger.warn(`Could not fetch previous bot comments: ${err}`);
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
        );
      } catch (err) {
        logger.error(
          `Review engine failed in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
        break;
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
          buildReviewBody(history, config.maxIterations, 'reviewing', result),
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

      const gitOpts: ExecFileSyncOptions = workingDir
        ? { cwd: workingDir, ...(gitEnv ? { env: { ...process.env, ...gitEnv } } : {}) }
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
            buildReviewBody(history, config.maxIterations, 'no-changes', result),
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
        `fix: address review feedback (iteration ${i + 1})`;

      try {
        execFileSync('git', ['add', '-A'], gitOpts);
        execFileSync(
          'git',
          ['commit', '-m', `fix: address review feedback (iteration ${i + 1})`],
          gitOpts,
        );
        validateRefName(pr.headRef);
        execFileSync('git', ['push', 'origin', pr.headRef], gitOpts);
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
            logger.warn(`Could not update PR description: ${updateErr}`);
          }
        }
      } catch (err) {
        logger.error(
          `Git operations failed in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
        try {
          await gh.postOrUpdateComment(
            prNumber,
            REVIEW_MARKER,
            buildReviewBody(history, config.maxIterations, 'reviewing', result),
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
        let program: string;
        let args: string[];
        try {
          const validated = validateRunChecksCommand(
            runChecksAfterFix,
            checkAllowlist ?? DEFAULT_ALLOWLIST,
          );
          program = validated.program;
          args = validated.args;
        } catch (err) {
          logger.warn(
            `Verification command rejected: ${err instanceof Error ? err.message : String(err)}`,
          );
          program = '';
          args = [];
        }

        if (program) {
          const maxVerificationRetries = 2;
          for (let v = 0; v <= maxVerificationRetries; v++) {
            let checkOutput = '';
            const execOpts = {
              encoding: 'utf-8' as const,
              stdio: 'pipe' as const,
              timeout: 300_000,
              ...(workingDir ? { cwd: workingDir } : {}),
            };
            try {
              const stdout = execFileSync(program, args, execOpts);
              checkOutput += stdout;
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
                    execFileSync('git', ['add', '-A'], gitOpts);
                    execFileSync(
                      'git',
                      ['commit', '-m', `fix: verification errors (attempt ${v + 1})`],
                      gitOpts,
                    );
                    validateRefName(pr.headRef);
                    execFileSync('git', ['push', 'origin', pr.headRef], gitOpts);
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
          buildReviewBody(history, config.maxIterations, 'max-iterations'),
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
