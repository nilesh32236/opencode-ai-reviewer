import path from 'node:path';
import type {
  AgentConfig,
  EventBus,
  IssueContext,
  PRContext,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import {
  Logger,
  ReviewEngine,
  buildAutofixDeferredBody,
  buildAutofixPRBody,
  commitAndPushWithLease,
  markAnalysisReady,
  parseAnalysisPlan,
  postBlockingQuestions,
  prepareBranchWorkspace,
  sanitizeErrorMessage,
  sanitizeMarkdown,
  validateRefName,
} from '@opencode-pr-agent/lib';
import { isBotLogin } from '../utils/bot.js';
import { buildRestrictedEnv, execProcess } from '../utils/exec.js';
import { execGit } from '../utils/git.js';
import { pathExists } from '../utils/temp.js';
import { isAbortError } from './command-helpers.js';

/** Module-scope logger for helper functions that have no per-call context. */
const logger = new Logger('Command');

/**
 * Find an existing autofix PR number linked from an issue body or comments.
 * @param issueNumber - The source issue number (used for logging).
 * @param issue - The issue context to scan for PR links.
 * @returns The linked PR number, or null when none is found.
 *
 * Exported for use by the command router.
 */
export async function findExistingAutofixPR(
  issueNumber: number,
  issue: IssueContext,
): Promise<number | null> {
  const logger = new Logger('Command', { prNumber: issueNumber });
  try {
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

/**
 * Create an autofix PR for an issue: set up the `autofix/issue-N` branch,
 * install workspace dependencies, run the fix engine, and open the PR.
 * @param gh - Platform adapter.
 * @param issueNumber - The source issue number.
 * @param repo - Repository string (owner/repo).
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory containing the cloned repo.
 * @param gitEnv - Git environment variables for authenticated git commands.
 * @param signal - Optional abort signal.
 * @param force - When true, auto-answer blocking questions instead of deferring.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 * @param initialIssue - Optional pre-fetched issue context.
 * @returns The created PR number, or null when no PR was created.
 */
export async function createAutofixPR(
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
  initialIssue?: IssueContext,
): Promise<number | null> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Fix triggered for issue #${issueNumber}`);

  if (signal?.aborted) return null;

  await gh.postOrUpdateComment(
    issueNumber,
    '<!-- autofix-in-progress -->',
    '🤖 **Autofix in progress...** The fix agent is analyzing the codebase and implementing changes. This may take a few minutes.',
  );

  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);
  const branchName = `autofix/issue-${issueNumber}`;
  validateRefName(branchName);

  try {
    const defaultBranch = await gh.getDefaultBranch();
    validateRefName(defaultBranch);

    if (signal?.aborted) return null;

    // Single owner for fetch → checkout → rebase (lib/): identical to the
    // inlined sequence this replaces (fresh branches start from the default
    // branch; existing branches are checked out and rebased).
    await prepareBranchWorkspace(execGit, {
      branchName,
      defaultBranch,
      cwd: tempDir,
      ...(gitEnv ? { env: gitEnv } : {}),
      ...(signal ? { signal } : {}),
      logger,
    });

    // The fix workspace is a fresh clone with no node_modules, so the AI agent's
    // verification commands (pnpm build/typecheck/lint) would fail with
    // "tsc: not found". Install dependencies once up front so the agent's own
    // checks and the structured verification steps all work.
    try {
      logger.info('Installing workspace dependencies for autofix PR...');
      signal?.throwIfAborted();
      // Credential isolation: installs run repo-controlled postinstall
      // scripts, so never forward provider keys or GITHUB_TOKEN. Combined
      // with isolateEnv, resolveExecDefaults skips the process.env merge
      // (same hardening as handleAutofixLoop).
      const installEnv: Record<string, string> = buildRestrictedEnv(
        gitEnv ? { GIT_ASKPASS: 'echo', GIT_TERMINAL_PROMPT: '0' } : undefined,
      );
      const installBase = {
        cwd: tempDir,
        env: installEnv,
        timeout: 600_000,
        isolateEnv: true,
      } as const;
      const withSignal = signal ? { ...installBase, signal } : installBase;
      let installed = false;
      if (await pathExists(path.join(tempDir, 'pnpm-lock.yaml'))) {
        await execProcess('pnpm', ['install'], withSignal);
        installed = true;
      } else if (await pathExists(path.join(tempDir, 'package-lock.json'))) {
        await execProcess('npm', ['ci'], withSignal);
        installed = true;
      }
      if (!installed) {
        logger.warn('No lockfile found in autofix workspace — skipping dependency install');
      } else {
        // Build the shared lib so its compiled `.d.ts` exists. Workspace
        // packages (app/cli) resolve `@opencode-pr-agent/lib` via its `exports`
        // → `./dist/index.d.ts`, which is absent after a fresh install; without
        // building lib first, their typecheck fails with "Cannot find module".
        logger.info('Building lib for autofix workspace...');
        signal?.throwIfAborted();
        await execProcess('pnpm', ['--filter', '@opencode-pr-agent/lib', 'build'], withSignal);
      }
    } catch (installErr) {
      if (signal?.aborted) return null;
      logger.warn(
        `Autofix dependency install failed: ${
          installErr instanceof Error ? installErr.message : String(installErr)
        } — continuing without dependencies`,
      );
    }

    let issue = initialIssue ?? (await gh.getIssue(issueNumber));
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
      signal?.throwIfAborted();
      const planMarkdown = await engine.runAnalyze(issueNumber, issueContext, undefined, tempDir);
      const parsed = parseAnalysisPlan(planMarkdown);
      // Same rendering cap as the action analyze flow: sanitize + bound the
      // posted comment (the full text is parsed above, so blocking questions
      // survive even if the rendering is cut).
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- issue-analysis-plan -->',
        sanitizeMarkdown(planMarkdown),
      );

      if (parsed.hasBlockingQuestions) {
        if (force) {
          logger.info('Force mode — auto-answering blocking questions');
          await autoAnswerBlockingQuestions(gh, issueNumber, parsed.blockingQuestions);
        } else {
          await postBlockingQuestions(gh, issueNumber, parsed);
          await gh.postOrUpdateComment(
            issueNumber,
            '<!-- autofix-deferred -->',
            buildAutofixDeferredBody(),
          );
          return null;
        }
      } else {
        await markAnalysisReady(gh, issueNumber);
      }
    }

    if (signal?.aborted) return null;

    // The analysis above may have posted a plan/questions/force-answers comment
    // and swapped labels, and the clone/fetch/checkout branch setup can take
    // minutes. Re-fetch right before the pending-question checks so a user's
    // answer comment that landed meanwhile is observed — otherwise an
    // answerable fix is wrongly deferred on a stale issue.
    issue = await gh.getIssue(issueNumber);
    issueContext = await gh.gatherContext({ issueNumber });

    const hasQuestionsPending = await checkForUnansweredQuestions(issue, issueContext);
    if (hasQuestionsPending) {
      if (force) {
        logger.info('Force mode — auto-answering pending questions from previous analysis');
        const pendingQuestions = await extractBlockingQuestions(issue);
        await autoAnswerBlockingQuestions(gh, issueNumber, pendingQuestions);
      } else {
        logger.info(`Issue #${issueNumber} has unanswered blocking questions — fix deferred`);
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- autofix-deferred -->',
          buildAutofixDeferredBody(),
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
    signal?.throwIfAborted();
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

    try {
      await commitAndPushWithLease(execGit, {
        message: `fix: address issue #${issueNumber}`,
        branchName,
        cwd: tempDir,
        ...(gitEnv ? { env: gitEnv } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      logger.error(`Git push failed: ${sanitizeErrorMessage(err)}`);
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- autofix-error -->',
          `❌ Autofix push failed: ${sanitizeErrorMessage(err)}`,
        );
      } catch (commentErr) {
        logger.warn(
          `Failed to post autofix push-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
        );
      }
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
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-error -->',
        `❌ Failed to create autofix PR from branch \`${branchName}\`. A PR may already exist from this branch or the API rejected the request.`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post autofix-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
    return null;
  } catch (err) {
    if (isAbortError(err, signal)) {
      logger.info(`Autofix PR creation aborted for issue #${issueNumber}`);
      return null;
    }
    logger.error(
      `Autofix PR creation failed for issue #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-error -->',
        `❌ **Autofix failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post autofix-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
    return null;
  } finally {
    try {
      await engine.cleanup();
    } catch (cleanupErr) {
      logger.warn(
        `Engine cleanup failed for autofix #${issueNumber}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }
}

/**
 * Check whether an issue still has unanswered analysis blocking questions.
 * @param issue - The issue context, already fetched by the caller.
 * @param issueContext - The gathered markdown context for the issue.
 * @returns True when blocking questions are still awaiting user answers.
 */
async function checkForUnansweredQuestions(
  issue: IssueContext,
  issueContext: string,
): Promise<boolean> {
  if (!issueContext.includes('<!-- issue-analysis-questions -->')) {
    return false;
  }
  try {
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
      `Failed to check unanswered questions for #${issue.number}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

/**
 * Build markdown Q&A context from post-question human answers.
 * @param comments - Issue comments in chronological order.
 * @returns Markdown Q&A section, or an empty string when there are no answers.
 */
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
 * @param issue - The issue context, already fetched by the caller.
 * @returns Array of blocking question strings
 */
async function extractBlockingQuestions(issue: IssueContext): Promise<string[]> {
  try {
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
