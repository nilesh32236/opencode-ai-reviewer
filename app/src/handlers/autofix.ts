import { execFileSync, execSync } from 'child_process';
import type { ExecFileSyncOptions } from 'child_process';
import type { AgentConfig, FixResult, PRContext, ReviewResult } from '@opencode-pr-agent/lib';
import { GitHubHelper, Logger, ReviewEngine, configureGit } from '@opencode-pr-agent/lib';

interface IterationRecord {
  iteration: number;
  status: 'approved' | 'fix-applied' | 'needs-fix' | 'no-changes';
  summary: string;
  critical: number;
  important: number;
  minor: number;
  filesChanged?: string[];
  commitMessage?: string;
}

const REVIEW_MARKER = '<!-- autofix-review -->';
const FIX_MARKER = '<!-- autofix-applied -->';

function buildReviewBody(
  history: IterationRecord[],
  maxIterations: number,
  phase: 'reviewing' | 'approved' | 'no-changes' | 'max-iterations',
  current?: ReviewResult,
): string {
  const lines: string[] = ['## 🤖 Autofix Review', ''];
  const currentIter = history.length;

  switch (phase) {
    case 'reviewing':
      lines.push(`**Status:** 🔍 Reviewing (iteration ${currentIter}/${maxIterations})`);
      break;
    case 'approved':
      lines.push('**Status:** ✅ Approved — all issues resolved');
      break;
    case 'no-changes':
      lines.push(
        `**Status:** ℹ️ Fix agent made no changes (iteration ${currentIter}/${maxIterations})`,
      );
      break;
    case 'max-iterations':
      lines.push('**Status:** ⚠️ Manual review required');
      break;
  }

  if (current) {
    if (current.summary) lines.push('', '### Summary', '', current.summary);
    if (current.issues.length > 0) {
      lines.push('', '### Issues Found');
      for (const i of current.issues) {
        lines.push(`- **${i.severity.toUpperCase()}:** ${i.file}:${i.line} — ${i.message}`);
        if (i.suggestion) lines.push(`  > ${i.suggestion}`);
      }
    }
    if (current.strengths.length > 0) {
      lines.push('', '### Strengths');
      for (const s of current.strengths) {
        lines.push(`- ✅ **${s.file}:${s.line}** — ${s.message}`);
      }
    }
  }

  if (history.length > 0) {
    lines.push('', '### Iteration History');
    for (const h of history) {
      let icon: string;
      let detail: string;
      switch (h.status) {
        case 'approved':
          icon = '✅';
          detail = 'All issues resolved';
          break;
        case 'fix-applied':
          icon = '🔧';
          detail = `Fix applied — ${h.critical} critical, ${h.important} important`;
          break;
        case 'needs-fix':
          icon = '❌';
          detail = `${h.critical} critical, ${h.important} important remaining`;
          break;
        case 'no-changes':
          icon = 'ℹ️';
          detail = 'No changes made';
          break;
      }
      lines.push(`- ${icon} **Iteration ${h.iteration}:** ${detail}`);
    }
  }

  switch (phase) {
    case 'approved':
      lines.push('', '✅ **Ready to merge!**');
      break;
    case 'max-iterations':
      lines.push(
        '',
        `⚠️ **Max iterations reached (${maxIterations}).** This PR needs manual review.`,
      );
      break;
  }

  return lines.join('\n');
}

function buildFixBody(history: IterationRecord[]): string {
  const last = history[history.length - 1];
  const lines: string[] = ['## 🔧 Autofix Applied', ''];
  if (last) {
    lines.push(`**Iteration:** ${last.iteration}`);
    lines.push(`**Files changed:** ${last.filesChanged?.length ?? 0}`);
    if (last.commitMessage) lines.push(`**Commit:** \`${last.commitMessage}\``);
    if (last.filesChanged && last.filesChanged.length > 0) {
      lines.push('', '### Changed Files');
      for (const f of last.filesChanged) lines.push(`- \`${f}\``);
    }
  }
  lines.push(
    '',
    '---',
    '',
    '🤖 The fix agent has applied changes. The PR will be reviewed again on the next iteration.',
  );
  return lines.join('\n');
}

function buildReadyBody(history: IterationRecord[], prNumber: number): string {
  const lines: string[] = ['## ✅ Ready to Merge', ''];
  lines.push(`All issues have been resolved in PR #${prNumber}.`);
  lines.push(
    '',
    'The review agent has approved this PR. A maintainer can merge it at their discretion.',
  );
  if (history.length > 0) {
    for (const h of history) {
      if (h.summary) {
        lines.push('', '### Summary', '', h.summary);
        break;
      }
    }
  }
  return lines.join('\n');
}

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
 */
export async function handleAutofixLoop(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  runChecksAfterFix?: string,
  tempDir?: string,
  initialGitEnv?: Record<string, string>,
): Promise<void> {
  const logger = new Logger('Autofix', { prNumber, repo });
  logger.info(`Starting autofix loop for PR #${prNumber} in ${repo}`);

  const gh = new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, token, repo);
  const history: IterationRecord[] = [];
  let approved = false;

  let gitEnv = initialGitEnv;
  if (!gitEnv && tempDir) {
    gitEnv = configureGit(
      'opencode-pr-agent[bot]',
      'opencode-pr-agent[bot]@users.noreply.github.com',
      token,
      tempDir,
    );
  } else if (!gitEnv) {
    configureGit(
      'opencode-pr-agent[bot]',
      'opencode-pr-agent[bot]@users.noreply.github.com',
      token,
    );
  }
  try {
    for (let i = 0; i < config.maxIterations; i++) {
      logger.info(`=== Autofix iteration ${i + 1}/${config.maxIterations} ===`);

      let pr: PRContext;
      try {
        pr = await gh.getPR(prNumber);
      } catch (err) {
        logger.error(
          `Failed to get PR in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
        break;
      }

      const reviewWorkingDir = tempDir || process.cwd();
      let result: ReviewResult;
      try {
        result = await engine.reviewPR(
          pr,
          i,
          undefined,
          undefined,
          undefined,
          undefined,
          reviewWorkingDir,
        );
      } catch (err) {
        logger.error(
          `Review engine failed in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        );
        break;
      }

      if (
        !result ||
        (!result.summary && result.issues.length === 0 && result.strengths.length === 0)
      ) {
        logger.error(`Review returned empty result in iteration ${i + 1}`);
        break;
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

      const gitOpts: ExecFileSyncOptions = tempDir
        ? { cwd: tempDir, ...(gitEnv ? { env: { ...process.env, ...gitEnv } } : {}) }
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
        execFileSync('git', ['push', 'origin', pr.headRef], gitOpts);
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
        const maxVerificationRetries = 2;
        for (let v = 0; v <= maxVerificationRetries; v++) {
          let checkOutput = '';
          const checkCmd = runChecksAfterFix;
          const execOpts = {
            encoding: 'utf-8' as const,
            stdio: 'pipe' as const,
            timeout: 300_000,
            ...(tempDir ? { cwd: tempDir } : {}),
          };
          try {
            const stdout = execSync(checkCmd, execOpts);
            checkOutput += stdout;
            logger.info('Verification passed');
            break;
          } catch (err) {
            const stderr = (err as Record<string, unknown>)?.stderr?.toString() ?? '';
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
                const freshPr = await gh.getPR(prNumber);
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
  }
}
