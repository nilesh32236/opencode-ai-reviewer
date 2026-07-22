import { execFileSync, execSync } from 'child_process';
import type { AgentConfig, FixResult, PRContext, ReviewResult } from '@opencode-pr-agent/lib';
import { GitHubHelper, Logger, ReviewEngine, configureGit } from '@opencode-pr-agent/lib';

const COMMAND_ALLOWLIST = ['pnpm', 'npm', 'yarn', 'node'];

function validateCommand(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('run_checks_after_fix must not be empty');
  const parts = trimmed.split(/\s+/);
  const program = parts[0];
  if (!COMMAND_ALLOWLIST.includes(program)) {
    throw new Error(
      `Command "${program}" is not allowed. Allowed programs: ${COMMAND_ALLOWLIST.join(', ')}`,
    );
  }
  for (const arg of parts.slice(1)) {
    if (/[;&|`$(){}<>\n\r]/.test(arg)) {
      throw new Error(`Argument "${arg}" contains unsafe shell characters`);
    }
  }
}

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

export async function handleAutofixLoop(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  runChecksAfterFix?: string,
): Promise<void> {
  const logger = new Logger('Autofix', { prNumber, repo });
  logger.info(`Starting autofix loop for PR #${prNumber} in ${repo}`);

  const gh = new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, token, repo);
  const history: IterationRecord[] = [];
  let approved = false;

  configureGit('opencode-pr-agent[bot]', 'opencode-pr-agent[bot]@users.noreply.github.com', token);
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

      let result: ReviewResult;
      try {
        result = await engine.reviewPR(pr, i);
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

      let fixResult: FixResult | undefined;
      try {
        fixResult = await engine.runFix(prNumber, i, contextMd, pr);
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
        execFileSync('git', ['add', '-A']);
        execFileSync('git', ['commit', '-m', `fix: address review feedback (iteration ${i + 1})`]);
        execFileSync('git', ['push', 'origin', pr.headRef]);
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
        const checkCmd = runChecksAfterFix;
        try {
          validateCommand(checkCmd);
        } catch (validationErr) {
          logger.error(
            `Invalid verification command: ${validationErr instanceof Error ? validationErr.message : validationErr}`,
          );
          break;
        }
        const maxVerificationRetries = 2;
        for (let v = 0; v <= maxVerificationRetries; v++) {
          let checkOutput = '';
          try {
            const stdout = execSync(checkCmd, {
              encoding: 'utf-8',
              stdio: 'pipe',
              timeout: 300_000,
            });
            checkOutput += stdout;
            logger.info('Verification passed');
            break;
          } catch (err) {
            const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? '';
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
                const freshContextMd = await gh.gatherContext({ prNumber });
                const retryResult = await engine.runFix(
                  prNumber,
                  i,
                  freshContextMd,
                  freshPr,
                  undefined,
                  result.issues,
                  checkOutput,
                );

                if (retryResult?.changesMade) {
                  execFileSync('git', ['add', '-A']);
                  execFileSync('git', [
                    'commit',
                    '-m',
                    `fix: verification errors (attempt ${v + 1})`,
                  ]);
                  execFileSync('git', ['push', 'origin', pr.headRef]);
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
