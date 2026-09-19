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
  type CheckExecution,
  DEFAULT_ALLOWLIST,
  FIX_MARKER,
  type IterationRecord,
  Logger,
  REVIEW_MARKER,
  ReviewEngine,
  buildAutofixPRBody,
  buildAutofixStatusBody,
  buildFixBody,
  buildFunctionScoreOptions,
  buildReadyBody,
  checkHeadCIGreen,
  configureGit,
  createPlatformAdapter,
  ensureWorkspaceDeps,
  isWorkingTreeClean,
  resolveFixedComments,
  runVerificationCycle,
  sanitizeErrorMessage,
  sanitizeString,
  validateRefName,
  withRetry,
} from '@opencode-pr-agent/lib';
import { mergeRepoConfig } from '../utils/config.js';
import { buildRestrictedEnv, execProcess } from '../utils/exec.js';
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

  const gh: PlatformAdapter = createPlatformAdapter(token, repo, config.platform);
  // Resolve the merged config once so the engine and the review-posting display
  // flags (inline comments, function scores) observe the same per-repo values.
  const effectiveConfig = mergeRepoConfig(config, tempDir);
  const engine = new ReviewEngine(effectiveConfig, gh, undefined, eventBus, repo, correlationId);
  const history: IterationRecord[] = [];
  const previousFindings: PreviousFindingIteration[] = [];
  let approved = false;
  // Tracks a CI-only block (review clean, CI not yet green) so the terminal
  // below preserves the `autofix` waiting state instead of relabeling to
  // `autofix:needs-manual-review`.
  let ciWaiting = false;

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
    // The fix workspace is a fresh clone with no dependencies. Install them
    // once up front so the AI agent's own verification commands (pnpm
    // build/typecheck/lint) and the structured runChecksAfterFix steps find
    // node_modules without the agent having to install on every iteration.
    if (workingDir) {
      try {
        // Single install matrix in lib/workspace-deps (incl. lockfileVersion 9).
        // Restricted env: install runs repo-controlled postinstall scripts,
        // so never forward provider keys or GITHUB_TOKEN. Combined with
        // isolateEnv, resolveExecDefaults skips the process.env merge.
        await ensureWorkspaceDeps({
          cwd: workingDir,
          ...(signal ? { signal } : {}),
          env: buildRestrictedEnv(
            gitEnv ? { GIT_ASKPASS: 'echo', GIT_TERMINAL_PROMPT: '0' } : undefined,
          ),
          isolateEnv: true,
          run: (program, args, opts) =>
            execProcess(program, args, {
              cwd: opts.cwd,
              ...(opts.env ? { env: opts.env } : {}),
              timeout: opts.timeout,
              ...(opts.signal ? { signal: opts.signal } : {}),
              ...(opts.isolateEnv ? { isolateEnv: true as const } : {}),
            }),
          logger,
        });
      } catch (installErr) {
        if (signal?.aborted) return;
        logger.warn(
          `Autofix dependency install failed: ${
            installErr instanceof Error ? installErr.message : String(installErr)
          } — continuing without dependencies`,
        );
      }
    }

    for (let i = 0; i < config.maxIterations; i++) {
      if (signal?.aborted) return;
      // A CI-waiting block from a prior iteration must not latch: later fix
      // work that exhausts must still reach the needs-manual-review terminal.
      // Only a terminal CI-block preserves the waiting state.
      ciWaiting = false;
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
      signal?.throwIfAborted();
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
        if (signal?.aborted) return;
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

      // The review above is a long LLM call: a push during review leaves the
      // pre-review head SHA stale. Re-fetch so both postReview and the CI gate
      // below target the current head. A refetch failure fails closed for this
      // iteration (skip on stale SHA) instead of gating on uncertain state.
      try {
        const fresh = await withRetry(() => gh.getMR(prNumber), {
          operationName: 'autofix.getMR.refresh',
          signal,
        });
        pr = fresh;
      } catch (err) {
        logger.warn(
          `Failed to re-fetch PR #${prNumber} after review in iteration ${i + 1} — skipping CI gate on stale SHA: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const gateSha = pr.headSha;

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
          effectiveConfig.review.inline,
          undefined,
          {
            ...(buildFunctionScoreOptions(
              effectiveConfig.review.showFunctionScores,
              pr.changedFiles,
            ) ?? {}),
            ...(effectiveConfig.review.sensitivity?.noiseBudget !== undefined
              ? { maxVisibleFindings: effectiveConfig.review.sensitivity.noiseBudget }
              : {}),
          },
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
        // Fail-closed CI gate (mirrors action/src/fix.ts): a clean review must
        // not yield `autofix:ready` without green CI on the exact head SHA.
        // Empty rollups, pending/failed/skipped checks, or query errors keep
        // the PR in `autofix` for another cycle.
        let ciGate: { ok: boolean; reason: string };
        try {
          // Retried like the surrounding hot-loop fetches and the Action
          // mirror: a single transient 429/5xx must not consume a whole
          // iteration (including the expensive review above). Persistent
          // failures still fail closed via the catch.
          ciGate = await withRetry(() => checkHeadCIGreen(gh, gateSha, undefined, signal), {
            operationName: 'autofix.checkHeadCI',
            maxRetries: 2,
            signal,
          });
        } catch (err) {
          ciGate = {
            ok: false,
            reason: `CI gate error for ${String(gateSha ?? '').slice(0, 7) || 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (!ciGate.ok) {
          logger.warn(
            `Review clean but ${ciGate.reason} — refusing autofix:ready, staying in autofix`,
          );
          entry.status = 'needs-fix';
          history.push(entry);
          try {
            await withRetry(() => gh.setLabels(prNumber, ['autofix'], ['autofix:ready']), {
              operationName: 'autofix.setLabels.ciBlocked',
              maxRetries: 2,
              signal,
            });
          } catch (err) {
            logger.error(
              `Failed to set autofix labels: ${err instanceof Error ? err.message : err}`,
            );
          }
          try {
            await withRetry(
              () =>
                gh.postOrUpdateComment(
                  prNumber,
                  REVIEW_MARKER,
                  `${buildAutofixStatusBody(history, config.maxIterations, 'reviewing', result)}\n\n⏳ **Waiting on CI** — ${sanitizeString(ciGate.reason)}. \`autofix:ready\` will be applied once CI is green on the head SHA.`,
                ),
              { operationName: 'autofix.postComment.ciBlocked', maxRetries: 2, signal },
            );
          } catch (err) {
            logger.error(
              `Failed to post CI-waiting comment: ${err instanceof Error ? err.message : err}`,
            );
          }
          // CI is not green: skip fix work for this clean review and re-check
          // on the next cycle. Mark CI-waiting so the terminal below preserves
          // the waiting state instead of relabeling to needs-manual-review.
          ciWaiting = true;
          continue;
        }
        approved = true;
        entry.status = 'approved';
        history.push(entry);

        try {
          await gh.setLabels(prNumber, ['autofix:ready'], ['autofix', 'autofix:needs-fix']);
        } catch (err) {
          logger.error(
            sanitizeErrorMessage(
              `Failed to set labels: ${err instanceof Error ? err.message : err}`,
            ),
          );
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
      signal?.throwIfAborted();
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
        if (signal?.aborted) return;
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
        `fix: address review feedback (iteration ${i + 1})`;

      try {
        await execGit(['add', '-A'], gitOpts);
        // The fix agent can report changes while leaving the tree clean (only
        // ignored files written, or edits identical to HEAD). Committing then
        // fails with "nothing to commit" — a clean tree is not a git failure,
        // so skip the commit and let the loop continue to verification and
        // the next review iteration instead of misreporting git-failure.
        if (await isWorkingTreeClean(execGit, gitOpts)) {
          logger.info('Working tree clean after fix — skipping commit, continuing loop');
        } else {
          await execGit(
            ['commit', '-m', `fix: address review feedback (iteration ${i + 1})`],
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
        }
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
        // The fix workspace is a fresh clone with no dependencies, so the
        // verification commands (pnpm build/typecheck/lint) cannot run.
        // Install dependencies once per iteration before checking (single
        // matrix in lib/workspace-deps; no lib rebuild per iteration).
        const baseCwd = workingDir ?? process.cwd();
        try {
          await ensureWorkspaceDeps({
            cwd: baseCwd,
            ...(signal ? { signal } : {}),
            env: buildRestrictedEnv(
              gitEnv ? { GIT_ASKPASS: 'echo', GIT_TERMINAL_PROMPT: '0' } : undefined,
            ),
            isolateEnv: true,
            buildLib: false,
            run: (program, args, opts) =>
              execProcess(program, args, {
                cwd: opts.cwd,
                ...(opts.env ? { env: opts.env } : {}),
                timeout: opts.timeout ?? 300_000,
                ...(opts.signal ? { signal: opts.signal } : {}),
                ...(opts.isolateEnv ? { isolateEnv: true as const } : {}),
              }),
            logger,
          });
        } catch (installErr) {
          if (signal?.aborted) return;
          logger.warn(
            `Dependency install failed before verification: ${
              installErr instanceof Error ? installErr.message : String(installErr)
            }`,
          );
        }

        // Single retry semantics in lib/verify-cycle (shared with action/fix).
        const cycle = await runVerificationCycle({
          command: runChecksAfterFix,
          allowlist: checkAllowlist ?? DEFAULT_ALLOWLIST,
          ...(signal ? { signal } : {}),
          logger,
          runStep: async (step: CheckExecution, _attempt: number) => {
            signal?.throwIfAborted();
            // Credential isolation: verification runs repo-controlled
            // build/typecheck/lint scripts, so they get the restricted env
            // with isolateEnv (never the full process.env with provider keys).
            const { stdout } = await execProcess(step.program, step.args, {
              cwd: step.cwd ? path.resolve(baseCwd, step.cwd) : baseCwd,
              env: buildRestrictedEnv(),
              timeout: 300_000,
              isolateEnv: true,
              ...(signal ? { signal } : {}),
            });
            return stdout;
          },
          runFix: async (checkOutput: string, attempt: number) => {
            logger.info(`Feeding verification error to fix engine (retry ${attempt + 1}/${2})...`);
            signal?.throwIfAborted();
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
            if (!retryResult?.changesMade) {
              logger.info('Fix agent made no changes to address verification errors');
              return false;
            }
            await execGit(['add', '-A'], gitOpts);
            // Same clean-tree guard as the main iteration commit:
            // "nothing to commit" must not fail verification loudly.
            if (await isWorkingTreeClean(execGit, gitOpts)) {
              logger.info('Working tree clean after verification retry — skipping commit');
              return false;
            }
            await execGit(
              ['commit', '-m', `fix: verification errors (attempt ${attempt + 1})`],
              gitOpts,
            );
            validateRefName(pr.headRef);
            await execGit(['push', 'origin', pr.headRef], gitOpts);
            return true;
          },
        });
        verificationPassed = cycle.passed;
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
        logger.error(
          sanitizeErrorMessage(
            `Failed to post fix comment: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
    }

    // A CI-waiting exit (review clean, CI not yet green) keeps the `autofix`
    // label and Waiting-on-CI comment written above — skip the
    // needs-manual-review relabel/comment.
    if (!approved && !ciWaiting) {
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
    try {
      await engine.cleanup();
    } catch (err) {
      logger.warn(
        `Engine cleanup failed for autofix loop #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (ownTempDir) {
      try {
        rmSync(ownTempDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}
