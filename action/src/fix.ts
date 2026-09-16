import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import type {
  AgentConfig,
  IssueComment,
  PlatformAdapter,
  PreviousFindingIteration,
  ReviewEngine,
} from '@opencode-pr-agent/lib';
import {
  type CheckExecution,
  FIX_MARKER,
  type IterationRecord,
  Logger,
  REVIEW_MARKER,
  buildAutofixPRBody,
  buildAutofixStatusBody,
  buildFixBody,
  buildFunctionScoreOptions,
  buildReadyBody,
  markAnalysisReady,
  parseAnalysisPlan,
  parseRunChecksCommands,
  postBlockingQuestions,
  resolveFixedComments,
  validateRefName,
  withRetry,
} from '@opencode-pr-agent/lib';
import { sanitizeMarkdown } from '@opencode-pr-agent/lib';
import { extractOperatorInstruction } from './comment-commands.js';
import type { ActionInputs } from './inputs.js';
import {
  capVerificationOutput,
  describeAbortKind,
  execWithTimeout,
  resolvePrNumber,
  sanitize,
} from './utils.js';

/**
 * Operator instruction passed from the triggering `/fix` comment.
 * A plain string is treated as raw comment text (classified internally);
 * the object form additionally carries the authorized actor for provenance.
 */
export interface FixOperatorInstruction {
  /** Raw comment text or pre-extracted instruction remainder. */
  instruction?: string;
  /** Authorized comment author login (used only for provenance header). */
  actor?: string;
}

/**
 * Build the provenanced operator-instruction section appended to fix-agent
 * context. The header marks the text as an authorized operator instruction
 * (highest priority after the system prompt) — never as untrusted
 * third-party prompt content. The permission gate in `index.ts` still runs
 * first; this helper only formats text that survived authorization.
 * @param instruction - Classified instruction remainder (non-empty).
 * @param actor - Authorized comment author login, when known.
 * @returns The markdown section to append to the fix context.
 */
export function buildOperatorInstructionSection(instruction: string, actor?: string): string {
  const safeActor = actor && /^[A-Za-z0-9-]{1,39}$/.test(actor) ? actor : undefined;
  const header = safeActor
    ? `## Operator Instruction (authorized /fix comment by @${safeActor} — highest priority after system prompt)`
    : '## Operator Instruction (authorized /fix comment — highest priority after system prompt)';
  return `${header}\n\n${instruction}`;
}

/**
 * Append an operator-instruction section to fix-agent context.
 * Returns `context` byte-identical when `instruction` is missing/blank, so
 * no-comment triggers (label, dispatch, GitLab) behave exactly as today.
 * @param context - Assembled issue/PR context markdown.
 * @param instruction - Classified instruction remainder, when any.
 * @param actor - Authorized comment author login, when known.
 * @returns The context with the provenanced section appended, or unchanged.
 */
export function appendOperatorInstruction(
  context: string,
  instruction?: string,
  actor?: string,
): string {
  if (!instruction || !instruction.trim()) return context;
  return `${context}\n\n${buildOperatorInstructionSection(instruction, actor)}`;
}

/**
 * Resolve the effective operator instruction from action inputs and/or an
 * explicit trailing override. Classification (token stripping, truncation)
 * runs here so callers may pass raw comment bodies safely; double extraction
 * is idempotent for already-classified text.
 * @param inputs - Parsed action inputs (`commentBody` when the workflow passes `comment-body`).
 * @param operator - Trailing override (raw string or `{ instruction, actor }`).
 * @returns The classified instruction, or `undefined` when there is none.
 */
export function resolveOperatorInstruction(
  inputs: Pick<ActionInputs, 'commentBody'>,
  operator?: FixOperatorInstruction | string,
): string | undefined {
  const raw =
    typeof operator === 'string' ? operator : (operator?.instruction ?? inputs.commentBody);
  return extractOperatorInstruction(raw);
}

/**
 * Resolve the provenance actor: explicit override first, then the in-process
 * GitHub comment payload, then the workflow actor (only when a comment payload
 * body exists). Returns `undefined` on non-comment triggers (schedule,
 * dispatch, label) and on GitLab / non-comment triggers (no-op provenance),
 * so provenance is never misattributed to e.g. a scheduler.
 * @param operator - Trailing override carrying an optional actor.
 * @returns The actor login, or `undefined` when unknown/unsafe.
 */
export function resolveOperatorActor(
  operator?: FixOperatorInstruction | string,
): string | undefined {
  const explicit = typeof operator === 'object' ? operator?.actor : undefined;
  if (explicit && /^[A-Za-z0-9-]{1,39}$/.test(explicit)) return explicit;
  try {
    const comment = github?.context?.payload?.comment as
      | { body?: unknown; user?: { login?: string } }
      | undefined;
    const login = comment?.user?.login;
    if (typeof login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(login)) return login;
    if (typeof comment?.body !== 'string') return undefined;
    const fallback = (github?.context as { actor?: unknown } | undefined)?.actor;
    if (typeof fallback === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(fallback)) return fallback;
  } catch {
    /* ignore — provenance is best-effort */
  }
  return undefined;
}

/**
 * Determine whether a PR/MR has already been closed or merged, so a fix
 * loop can stop pushing iteration commits instead of force-pushing onto a
 * merged branch (which is what orphaned PR #466's hardening).
 *
 * GitHub reports state as 'open' | 'closed' | 'merged'; GitLab reports
 * 'opened' | 'closed' | 'merged'. An undefined state (older adapter builds
 * that did not populate it) is treated as still open so existing callers are
 * never silently blocked.
 * @param state - The PR/MR state string, when known.
 * @returns True when the PR/MR is closed or merged.
 */
export function isPrClosedOrMerged(state?: string): boolean {
  if (!state) return false;
  return state === 'closed' || state === 'merged';
}

/**
 * Run a single fix iteration on a PR: resolve PR, gather context, apply
 * changes, optionally verify with a user-configured command, and push.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps, and races verification timeouts.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 * @param operator - Optional operator instruction from the triggering `/fix`
 *   comment (raw string or `{ instruction, actor }`). Classified internally;
 *   absent means behave exactly as today.
 */
export async function runFix(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  signal?: AbortSignal,
  operator?: FixOperatorInstruction | string,
): Promise<void> {
  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for fix');
    core.setOutput('changes_made', 'false');
    return;
  }

  const COMMENTS_PER_PAGE = 100;
  const COMMENT_PAGES_MAX = 10;
  let comments: IssueComment[];
  try {
    // Bound the fetch while preserving full-history semantics: pages stop
    // early once enough REVIEW_MARKERs are seen to trip the maxIterations
    // gate, and throwOnError keeps page failures loud so the count is never
    // silently computed from a truncated list. Note: GitHub's list-issue-
    // comments endpoint ignores sort direction (always oldest-first; GitLab
    // honors sort), so early-stop savings apply on GitLab while GitHub scans
    // oldest-first within the 10-page bound.
    const recent = await gh.listComments(prNumber, {
      perPage: COMMENTS_PER_PAGE,
      maxPages: COMMENT_PAGES_MAX,
      direction: 'desc',
      throwOnError: true,
      stopWhen: (items) =>
        items.filter((c) => String((c as { body?: unknown }).body ?? '').includes(REVIEW_MARKER))
          .length >= config.maxIterations,
    });
    comments = recent.map((c) => ({
      id: typeof c.id === 'number' ? c.id : 0,
      author: '',
      createdAt: '',
      body: typeof c.body === 'string' ? c.body : '',
    }));
  } catch (err) {
    core.setFailed(
      sanitize(
        `Failed to fetch issue comments for iteration count: ${err instanceof Error ? err.message : err}`,
      ),
    );
    core.setOutput('changes_made', 'false');
    return;
  }
  // listComments is bounded to COMMENT_PAGES_MAX x COMMENTS_PER_PAGE (1000
  // total). On repos with more comments the REVIEW_MARKER count below is
  // computed from a truncated oldest-first list (GitHub ignores sort
  // direction), so the maxIterations gate may be bypassed. Fail closed when
  // the cap is hit instead of warning and continuing, so an attacker-inflated
  // comment list cannot buy extra autofix iterations.
  // Conservative tradeoff: length can never exceed the cap, so a PR with
  // exactly 1000 legitimate comments false-positives as truncated and aborts
  // for manual review. There is no hasMore signal to distinguish a full from
  // a truncated list, and failing closed (one manual review) is preferred
  // over failing open (unbounded autofix iterations).
  if (comments.length >= COMMENT_PAGES_MAX * COMMENTS_PER_PAGE) {
    core.setFailed(
      sanitize(
        `Issue comment list truncated at ${comments.length} comments (${COMMENT_PAGES_MAX} pages x ${COMMENTS_PER_PAGE}); REVIEW_MARKER iteration count may be incomplete and maxIterations (${config.maxIterations}) cannot be verified — aborting for manual review.`,
      ),
    );
    core.setOutput('changes_made', 'false');
    return;
  }
  const iteration = comments.filter((c: IssueComment) => c.body.includes(REVIEW_MARKER)).length;

  if (iteration >= config.maxIterations) {
    const errorMsg = `Max iterations reached (${config.maxIterations}). Needs manual review.`;
    try {
      await withRetry(
        () =>
          gh.setLabels(prNumber, ['autofix:needs-manual-review'], ['autofix', 'autofix:needs-fix']),
        { operationName: 'fix.setLabels.maxIterations', maxRetries: 2, signal },
      );
    } catch (err) {
      core.warning(
        sanitize(
          `Failed to set max-iterations labels on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      new Logger('Fix').warn('Failed to set max-iterations labels', {
        operation: 'fix.setLabels.maxIterations',
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    core.setFailed(errorMsg);
    core.setOutput('changes_made', 'false');
    return;
  }

  // Fetch PR and context in parallel: gatherContext internally re-fetches
  // /pulls + /files, so sequential fetches pay 2x PR fetch plus two serial
  // withRetry backoff windows. Plain try/catch matches every other withRetry
  // call site (docs.ts, changelog.ts, describe.ts).
  let pr: Awaited<ReturnType<typeof gh.getMR>>;
  let contextMarkdown: string;
  try {
    [pr, contextMarkdown] = await Promise.all([
      withRetry(() => gh.getMR(prNumber), { operationName: 'fix.getMR', signal }),
      withRetry(() => gh.gatherContext({ prNumber }), {
        operationName: 'fix.gatherContext',
        signal,
      }),
    ]);
  } catch (err) {
    core.setFailed(
      sanitize(
        `Failed to fetch PR #${prNumber} context: ${err instanceof Error ? err.message : err}`,
      ),
    );
    core.setOutput('changes_made', 'false');
    return;
  }
  if (!pr) {
    core.setFailed(sanitize(`Failed to get PR #${prNumber}: empty response`));
    core.setOutput('changes_made', 'false');
    return;
  }

  // Operator instruction from the triggering /fix comment (highest priority
  // after the system prompt). Resolved from the explicit override first,
  // falling back to the `comment-body` input; absent means byte-identical
  // context (label/dispatch/GitLab triggers unchanged).
  const operatorInstruction = resolveOperatorInstruction(inputs, operator);
  const operatorActor = resolveOperatorActor(operator);
  if (operatorInstruction) {
    contextMarkdown = appendOperatorInstruction(
      contextMarkdown,
      operatorInstruction,
      operatorActor,
    );
  }

  const fixResult = await engine.runFix(prNumber, iteration, contextMarkdown, pr);

  let changesMade = false;
  if (fixResult?.changesMade) {
    // Guard: if the PR was merged or closed by another actor (e.g. the
    // orchestrator's auto-merge) while the fix loop was iterating, never
    // push iteration commits onto a merged branch. Stop the loop cleanly.
    if (isPrClosedOrMerged(pr.state)) {
      core.warning(
        sanitize(
          `PR #${prNumber} is already ${pr.state ?? 'closed/merged'} — skipping push of iteration ${iteration + 1} and stopping the fix loop`,
        ),
      );
      core.setOutput('changes_made', 'false');
      return;
    }
    try {
      await exec.exec('git', ['add', '-A']);
      await exec.exec('git', [
        'commit',
        '-m',
        `fix: address review feedback (iteration ${iteration + 1})`,
      ]);
      validateRefName(pr.headRef);
      await exec.exec('git', ['push', 'origin', pr.headRef]);
      changesMade = true;
    } catch (err) {
      const msg = `Git operations failed: ${err instanceof Error ? err.message : err}`;
      core.warning(sanitize(msg));
      // Fail loudly: a lost push must never be reported as success via
      // changes_made=true (mirrors runDocs, which rethrows on git failure).
      core.setFailed(sanitize(msg));
      core.setOutput('changes_made', 'false');
      return;
    }
  }

  if (inputs.runChecksAfterFix && changesMade) {
    core.info('Running verification commands...');
    let steps: CheckExecution[];
    try {
      steps = parseRunChecksCommands(inputs.runChecksAfterFix, inputs.checkAllowlist);
    } catch (err) {
      core.warning(
        sanitize(
          `Verification command rejected (${err instanceof Error ? err.message : err}). Skipping verification.`,
        ),
      );
      steps = [];
    }

    const maxVerificationRetries = 2;
    let verificationCancelled = false;
    for (let v = 0; v <= maxVerificationRetries; v++) {
      const { exitCode, output: checkOutput } = await runVerificationSteps(steps, signal);

      // A cancelled run must stop instead of feeding the cancelled output
      // back into the engine as ordinary verification failure.
      if (signal?.aborted) {
        verificationCancelled = true;
        break;
      }

      if (steps.length === 0) {
        break;
      }

      if (exitCode === 0) {
        core.info('Verification passed');
        break;
      }

      core.warning(
        sanitize(
          `Verification command failed (exit code ${exitCode}). Retrying fix with error output...`,
        ),
      );

      if (v < maxVerificationRetries) {
        let freshPr: Awaited<ReturnType<typeof gh.getMR>>;
        let freshContextMarkdown: string;
        try {
          [freshPr, freshContextMarkdown] = await Promise.all([
            withRetry(() => gh.getMR(prNumber), { operationName: 'fix.getMR', signal }),
            withRetry(() => gh.gatherContext({ prNumber }), {
              operationName: 'fix.gatherContext',
              signal,
            }),
          ]);
        } catch (err) {
          core.warning(
            sanitize(
              `Verification refetch failed, skipping retry: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          break;
        }
        if (operatorInstruction) {
          freshContextMarkdown = appendOperatorInstruction(
            freshContextMarkdown,
            operatorInstruction,
            operatorActor,
          );
        }
        const retryResult = await engine.runFix(
          prNumber,
          iteration,
          freshContextMarkdown,
          freshPr,
          undefined,
          undefined,
          checkOutput,
        );

        if (retryResult?.changesMade) {
          if (isPrClosedOrMerged(freshPr.state)) {
            core.warning(
              sanitize(
                `PR #${prNumber} is already ${freshPr.state ?? 'closed/merged'} — skipping verification-retry push (iteration ${iteration + 1})`,
              ),
            );
            core.setOutput('changes_made', 'false');
            return;
          }
          try {
            await exec.exec('git', ['add', '-A']);
            await exec.exec('git', [
              'commit',
              '-m',
              `fix: verification errors (iteration ${iteration + 1})`,
            ]);
            validateRefName(freshPr.headRef);
            await exec.exec('git', ['push', 'origin', freshPr.headRef]);
          } catch (err) {
            // Mirror the main push path: a lost verification push must never
            // report changes_made=true, so fail loudly and return.
            const msg = `Git operations during verification retry failed: ${err instanceof Error ? err.message : err}`;
            core.warning(sanitize(msg));
            core.setFailed(sanitize(msg));
            core.setOutput('changes_made', 'false');
            return;
          }
        }
      }
    }
    if (verificationCancelled) {
      // Fail visibly: without setFailed a cancelled run would fall through
      // to label cleanup and report success. changes_made reflects the push
      // that already happened above, so downstream steps see truthful state.
      const kind =
        signal && signal.reason !== undefined ? describeAbortKind(signal.reason) : 'cancelled';
      core.setFailed(sanitize(`Fix verification cancelled before completion (${kind}).`));
      core.setOutput('changes_made', String(changesMade ?? false));
      return;
    }
  }

  // Post-success label cleanup is best-effort: a transient API failure here
  // must never flip an actually-successful run to failed, and
  // changes_made outputs must still be set below.
  try {
    await withRetry(() => gh.removeLabel(prNumber, 'autofix:needs-fix'), {
      operationName: 'fix.removeLabel',
      maxRetries: 2,
      signal,
    });
  } catch (err) {
    core.warning(
      sanitize(
        `Failed to remove autofix:needs-fix label on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    new Logger('Fix').warn('Failed to remove label after success', {
      operation: 'fix.removeLabel',
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  core.setOutput('changes_made', String(changesMade ?? false));
}

/**
 * Check whether an existing bot-authored `autofix/issue-N` branch is based on
 * the current default-branch tip. A branch is fresh when the default tip is an
 * ancestor of (or equal to) the branch tip — i.e. `merge-base(branch, default)`
 * equals the default tip, or `merge-base --is-ancestor default branch` exits 0.
 * Probes fail closed toward "stale" (returns false) so an orphaned branch
 * whose base predates already-merged work is discarded rather than reused.
 * Callers must `validateRefName()` both args before calling (refs are
 * interpolated into git arguments).
 * @param branchName - Remote branch to check (e.g. 'autofix/issue-123').
 * @param defaultBranch - Default branch name (e.g. 'main').
 * @returns True when the branch tip contains the current default tip.
 */
async function isAutofixBranchFresh(branchName: string, defaultBranch: string): Promise<boolean> {
  try {
    const defaultTip = await exec.getExecOutput('git', ['rev-parse', `origin/${defaultBranch}`], {
      ignoreReturnCode: true,
    });
    if (defaultTip.exitCode !== 0 || !defaultTip.stdout.trim()) {
      core.info(
        'Autofix branch freshness check: could not resolve default tip — treating as stale',
      );
      return false;
    }
    const mergeBase = await exec.getExecOutput(
      'git',
      ['merge-base', `origin/${branchName}`, `origin/${defaultBranch}`],
      { ignoreReturnCode: true },
    );
    if (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim()) {
      core.info('Autofix branch freshness check: could not resolve merge-base — treating as stale');
      return false;
    }
    const defaultSha = defaultTip.stdout.trim();
    const baseSha = mergeBase.stdout.trim();
    if (baseSha === defaultSha) {
      core.info(`Autofix branch is fresh (merge-base ${baseSha} == origin/${defaultBranch} tip)`);
      return true;
    }
    const isAncestorExit = await exec.exec(
      'git',
      ['merge-base', '--is-ancestor', `origin/${defaultBranch}`, `origin/${branchName}`],
      { ignoreReturnCode: true },
    );
    const fresh = isAncestorExit === 0;
    core.info(
      `Autofix branch freshness check: merge-base ${baseSha}, origin/${defaultBranch} tip ${defaultSha} — ${fresh ? 'fresh (default tip is ancestor)' : 'STALE'}`,
    );
    return fresh;
  } catch (err) {
    core.info(
      sanitize(
        `Autofix branch freshness check failed (${err instanceof Error ? err.message : err}) — treating as stale`,
      ),
    );
    return false;
  }
}

/**
 * Run a fix triggered from an issue (non-PR): create a branch, apply the fix,
 * commit, push, and open a new PR.
 * Includes wall-clock timeout guarding against queue wait time.
 * @param inputs - Action inputs.
 * @param config - Agent config (provides timeoutMinutes).
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo).
 * @param gitEmail - Configured bot commit author email, used to verify that an
 *   existing `autofix/issue-N` branch tip was authored by this bot before it is
 *   reused (see `configureGit`).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps, and races verification timeouts.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 */
export async function runFixIssue(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  _repo: string,
  gitEmail: string,
  signal?: AbortSignal,
  operator?: FixOperatorInstruction | string,
): Promise<void> {
  const issueNumber = await resolvePrNumber();
  if (!issueNumber) {
    core.setFailed('Could not determine issue number');
    core.setOutput('changes_made', 'false');
    return;
  }

  // Wall-clock guard: detect when queue wait time has consumed most of the job budget.
  // GITHUB_RUN_STARTED_AT is set by GitHub Actions to the ISO timestamp when the
  // workflow run was queued — not when this job started. This lets us account for
  // time spent waiting in the queue or in earlier job steps.
  const configTimeoutMs = (config.timeoutMinutes ?? 20) * 60 * 1000;
  const runStartedAt = process.env.GITHUB_RUN_STARTED_AT
    ? new Date(process.env.GITHUB_RUN_STARTED_AT).getTime()
    : Date.now();
  const minRequiredMs = 90_000; // Need at least 90 seconds to attempt a meaningful fix

  core.info(`Fixing issue #${issueNumber}`);

  const branchName = `autofix/issue-${issueNumber}`;
  validateRefName(branchName);

  const defaultBranch = await gh.getDefaultBranch();
  validateRefName(defaultBranch);

  // Reuse an existing `origin/${branchName}` only when its tip commit was
  // authored by this bot (the configured git email) AND its base is fresh
  // (i.e. it contains the current `origin/${defaultBranch}` tip). Any
  // collaborator with push access can create a branch under the deterministic
  // `autofix/issue-N` name, so reusing an unverified branch would make
  // attacker-seeded content the base of the fix PR (which is force-pushed
  // below). A bot-authored tip is safe to reuse only when fresh, which
  // preserves the update-PR flow when `/fix` is re-triggered before the
  // previous autofix PR merges. A bot-authored but stale branch (base predates
  // already-merged work on the default branch) is discarded and recreated
  // from the default branch — otherwise the fix PR inherits stale history,
  // producing a conflicting PR with an inflated diff. Any other tip (or no
  // existing branch) is recreated from the repository's default branch. `-B`
  // also force-resets any stale local branch of the same name instead of
  // failing, which keeps re-triggered /fix runs robust on self-hosted
  // runners. Note this email check is a stale-branch-reuse heuristic, not a
  // security boundary — git author emails are self-asserted and forgeable, so
  // an attacker can pass it; the recreate-from-default path below is the
  // actual security control.
  let reuseBotBranch = false;
  // Best-effort refresh of remote refs so the freshness check below sees
  // current remote tips even on runners with stale refs.
  try {
    await exec.exec('git', ['fetch', 'origin', defaultBranch], { ignoreReturnCode: true });
  } catch {
    /* ignore — freshness probes below fail closed toward "stale" */
  }
  try {
    await exec.exec('git', ['fetch', 'origin', branchName], { ignoreReturnCode: true });
  } catch {
    /* ignore — freshness probes below fail closed toward "stale" */
  }
  const tipEmail = await exec
    .getExecOutput('git', ['log', '-1', '--format=%ae', `origin/${branchName}`], {
      ignoreReturnCode: true,
    })
    .then((r) => (r.exitCode === 0 ? r.stdout.trim() : ''))
    .catch(() => '');

  if (tipEmail === gitEmail) {
    if (await isAutofixBranchFresh(branchName, defaultBranch)) {
      reuseBotBranch = true;
      await exec.exec('git', ['checkout', '-B', branchName, `origin/${branchName}`]);
    } else {
      core.info(
        `Existing branch origin/${branchName} is bot-authored but stale — recreating from origin/${defaultBranch}`,
      );
      await exec.exec('git', ['checkout', '-B', branchName, `origin/${defaultBranch}`]);
    }
  } else {
    await exec.exec('git', ['checkout', '-B', branchName, `origin/${defaultBranch}`]);
  }

  let issueContext = await gh.gatherContext({ issueNumber });

  // Operator instruction from the triggering /fix comment. Resolved once here
  // (explicit override wins over the `comment-body` input) and appended after
  // every gatherContext so both the direct-fix and analyze-then-fix paths
  // carry it. Absent means byte-identical context (label/dispatch/GitLab
  // triggers unchanged). Consumed only after the index.ts permission gate.
  const operatorInstruction = resolveOperatorInstruction(inputs, operator);
  const operatorActor = resolveOperatorActor(operator);
  if (operatorInstruction) {
    issueContext = appendOperatorInstruction(issueContext, operatorInstruction, operatorActor);
  }

  // Auto-analyze if no implementation plan exists yet
  // gatherContext() strips the marker and replaces it with the header below,
  // so check both.
  const hasPlan =
    issueContext.includes('<!-- issue-analysis-plan -->') ||
    issueContext.includes('### Implementation Plan (from analysis)') ||
    issueContext.includes('# 🔍 Issue Analysis & Implementation Plan');
  if (!hasPlan) {
    core.info('No implementation plan found — running analyze first');
    const planMarkdown = await engine.runAnalyze(issueNumber, issueContext);
    const parsed = parseAnalysisPlan(planMarkdown);
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- issue-analysis-plan -->',
      sanitizeMarkdown(planMarkdown),
    );

    if (parsed.hasBlockingQuestions) {
      await postBlockingQuestions(gh, issueNumber, parsed);
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-deferred -->',
        '⏸️ **Fix Deferred** — Please answer the analysis questions first, then re-trigger `/fix`.',
      );
      core.setOutput('changes_made', 'false');
      return;
    }
    await markAnalysisReady(gh, issueNumber);

    issueContext = await gh.gatherContext({ issueNumber });
    if (operatorInstruction) {
      issueContext = appendOperatorInstruction(issueContext, operatorInstruction, operatorActor);
    }
  }

  const issue = await gh.getIssue(issueNumber);
  const questionsCommentIdx = issue.comments.findIndex((c) =>
    c.body.includes('<!-- issue-analysis-questions -->'),
  );
  if (questionsCommentIdx !== -1 && issue.labels.includes('analysis:needs-input')) {
    const repliesAfter = issue.comments
      .slice(questionsCommentIdx + 1)
      .filter((c) => !c.author.includes('[bot]'));

    if (repliesAfter.length === 0) {
      core.info('Issue has unanswered blocking questions — skipping fix');
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-deferred -->',
        '⏸️ **Fix Deferred** — Please answer the analysis questions first, then re-trigger `/fix`.',
      );
      core.setOutput('changes_made', 'false');
      return;
    }

    core.info('User replied to blocking questions — clearing analysis:needs-input label');
    await gh.removeLabel(issueNumber, 'analysis:needs-input');
    await markAnalysisReady(gh, issueNumber);
  }

  // Check remaining time budget just before calling OpenCode, after setup steps.
  const elapsedMs = Date.now() - runStartedAt;
  const timeLeftMs = configTimeoutMs - elapsedMs;
  if (signal?.aborted) {
    // Signal is advisory-only: engine.runFix accepts no AbortSignal, so this
    // pre-check cannot cancel an in-flight LLM call — it only fails fast
    // before starting work.
    const kind = signal.reason === undefined ? 'cancelled' : describeAbortKind(signal.reason);
    const abortMsg = `Fix cancelled before engine call (${kind}) — run deadline exceeded or workflow cancelled.`;
    core.warning(sanitize(abortMsg));
    core.setFailed(sanitize(abortMsg));
    core.setOutput('changes_made', 'false');
    return;
  }
  if (timeLeftMs < minRequiredMs) {
    const elapsedMin = (elapsedMs / 60_000).toFixed(1);
    const budgetMin = (configTimeoutMs / 60_000).toFixed(0);
    const msg = `Insufficient time remaining to run fix (elapsed: ${elapsedMin}m / budget: ${budgetMin}m, remaining: ${Math.round(timeLeftMs / 1000)}s < ${Math.round(minRequiredMs / 1000)}s required). The job likely waited in the queue too long. Re-trigger the fix with /fix.`;
    core.warning(sanitize(msg));
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-timeout -->',
        `⏳ **Autofix could not start** — the GitHub Actions runner was busy and this job spent too long in the queue.\n\nPlease comment \`/fix\` again to re-trigger the fix.\n\n---\n*🤖 Posted automatically by opencode-ai-reviewer*`,
      );
    } catch (commentErr) {
      core.warning(
        sanitize(
          `Failed to post timeout notice: ${commentErr instanceof Error ? commentErr.message : commentErr}`,
        ),
      );
    }
    core.setFailed(sanitize(msg));
    return;
  }

  // Pass remaining time as the effective timeout for OpenCode so it doesn't
  // overrun the GitHub Actions job budget.
  const remainingTimeoutMinutes = Math.max(1, Math.floor((timeLeftMs - 30_000) / 60_000));

  const fixResult = await engine.runFix(
    issueNumber,
    0,
    issueContext,
    undefined,
    remainingTimeoutMinutes,
  );

  if (!fixResult?.changesMade) {
    core.info('No changes made by fix agent');
    core.setOutput('changes_made', 'false');
    return;
  }

  const hasChanges = await exec
    .getExecOutput('git', ['status', '--porcelain'])
    .then((r) => r.stdout.trim().length > 0)
    .catch(() => false);

  if (!hasChanges) {
    core.info('No file changes to commit');
    core.setOutput('changes_made', 'false');
    return;
  }

  await exec.exec('git', ['add', '-A']);
  await exec.exec('git', ['commit', '-m', `fix: address issue #${issueNumber}`]);
  try {
    if (reuseBotBranch) {
      // Reusing a bot-authored branch that is based on the current default
      // tip: guard against a concurrent remote update.
      await exec.exec('git', ['push', 'origin', branchName, '--force-with-lease']);
    } else {
      // Recreating from the trusted default branch: the remote tip is being
      // deliberately replaced — but ONLY if it is still the tip inspected
      // above. A bare --force would silently discard commits pushed
      // concurrently (e.g. a human's manual fix pushed while the agent was
      // working). Pin the lease to the observed remote tip instead.
      // Shallow checkouts are covered: branchName was fetched explicitly
      // above, so origin/branchName exists whenever the remote branch exists.
      const remoteTip = await exec
        .getExecOutput('git', ['rev-parse', `origin/${branchName}`], { ignoreReturnCode: true })
        .then((r) => (r.exitCode === 0 ? r.stdout.trim() : ''))
        .catch(() => '');
      if (/^[0-9a-f]{40}$/.test(remoteTip)) {
        await exec.exec('git', [
          'push',
          'origin',
          branchName,
          `--force-with-lease=${branchName}:${remoteTip}`,
        ]);
      } else {
        // No remote branch (fresh create): nothing to clobber, plain push.
        await exec.exec('git', ['push', 'origin', branchName]);
      }
    }
  } catch (err) {
    core.warning(sanitize(`Git push failed: ${err instanceof Error ? err.message : err}`));
    core.setFailed(sanitize(`Git push failed: ${err instanceof Error ? err.message : err}`));
    core.setOutput('changes_made', 'false');
    return;
  }

  const prTitle = `[Autofix] ${issue.title}`;
  const prBody = buildAutofixPRBody({
    issueNumber,
    issueTitle: issue.title,
    fixSummary: fixResult.summary,
    filesChanged: fixResult.filesChanged ?? [],
    branchName,
    hasTests: !!inputs.runChecksAfterFix,
  });

  // Ensure the autofix label exists in the repository before referencing it in pr create
  await gh.ensureLabels(['autofix']);

  const baseBranch = await gh.getDefaultBranch();
  validateRefName(baseBranch);

  const prResult = await gh.createPR(prTitle, prBody, branchName, baseBranch);
  const prUrl = prResult?.url || '';

  if (prUrl) {
    core.info(`Created PR: ${prUrl}`);
    core.setOutput('pr_url', prUrl);
    if (prResult?.number) {
      try {
        await gh.addLabels(prResult.number, ['autofix']);
      } catch (err) {
        core.warning(
          sanitize(
            `Failed to label autofix PR #${prResult.number}: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
    }
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-pr-link -->',
        `🔧 Autofix PR: ${prUrl}`,
      );
    } catch (err) {
      core.warning(
        sanitize(`Failed to post autofix comment: ${err instanceof Error ? err.message : err}`),
      );
    }
  }

  core.setOutput('changes_made', 'true');
}

/**
 * Run the complete review-fix loop on a PR. Iterates up to config.maxIterations:
 * reviews the PR, applies fixes, runs optional verification, and posts
 * status comments. Stops early on approval or when no changes are made.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps, and races verification timeouts.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 */
export async function runAutofixLoop(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  _repo: string,
  _token: string,
  signal?: AbortSignal,
  operator?: FixOperatorInstruction | string,
): Promise<void> {
  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for autofix loop');
    return;
  }

  // Operator instruction from the triggering /fix comment (iteration-0 only,
  // highest priority after the system prompt). Absent means byte-identical
  // context (label/dispatch/GitLab triggers unchanged).
  const operatorInstruction = resolveOperatorInstruction(inputs, operator);
  const operatorActor = resolveOperatorActor(operator);

  const history: IterationRecord[] = [];
  const previousFindings: PreviousFindingIteration[] = [];
  let approved = false;
  let exitReason: 'approved' | 'no-changes' | 'git-failure' | 'timeout' | 'exhausted' = 'exhausted';

  const startTime = Date.now();
  const totalTimeoutMs = (config.timeoutMinutes ?? 20) * 60 * 1000;
  const gracePeriodMs = Math.max(30_000, totalTimeoutMs * 0.1);

  for (let i = 0; i < config.maxIterations; i++) {
    const elapsedMs = Date.now() - startTime;
    const timeLeftMs = totalTimeoutMs - elapsedMs;

    if (timeLeftMs <= gracePeriodMs) {
      core.warning(
        sanitize(
          `Autofix timeout approaching (remaining: ${Math.round(timeLeftMs / 1000)}s) — shutting down gracefully.`,
        ),
      );
      await handleTimeoutGracefully(prNumber, history, i, config, gh);
      return;
    }

    const iterTimeoutMinutes = Math.max(1, Math.round((timeLeftMs - gracePeriodMs) / (60 * 1000)));

    core.info(`=== Autofix iteration ${i + 1}/${config.maxIterations} ===`);

    // Hot-loop fetches must tolerate transient 429/5xx like every other call
    // site (runFix, docs.ts, self-heal verification refetch): without
    // withRetry a single transient failure aborts the whole multi-iteration
    // loop. A persistent failure still aborts the loop via setFailed below.
    let pr: Awaited<ReturnType<typeof gh.getMR>>;
    try {
      pr = await withRetry(() => gh.getMR(prNumber), {
        operationName: 'autofix.getMR',
        signal,
      });
    } catch (err) {
      core.setFailed(
        sanitize(
          `Failed to fetch PR #${prNumber} in autofix iteration ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (signal?.aborted) {
      // Signal is advisory-only: engine.reviewPR accepts no AbortSignal, so
      // this pre-check cannot cancel an in-flight LLM call.
      const cancelKind =
        signal.reason === undefined ? 'cancelled' : describeAbortKind(signal.reason);
      core.warning(
        sanitize(
          `Autofix loop cancelled before iteration ${i + 1} (${cancelKind}) — shutting down gracefully.`,
        ),
      );
      await handleTimeoutGracefully(prNumber, history, i, config, gh, true);
      return;
    }
    const prHeadSha = pr.headSha;

    let previousBotComments:
      | Array<{ file: string; line: number | null; body: string; commentId: number }>
      | undefined;
    try {
      const botThreads = await gh.getBotReviewThreads(prNumber);
      previousBotComments = botThreads
        .filter((t) => !t.isResolved && t.firstComment)
        .map((t) => ({
          file: t.firstComment.filePath,
          line: t.firstComment.lineNumber,
          body: t.firstComment.body,
          commentId: t.firstComment.databaseId,
        }));
    } catch (err) {
      const message = `Failed to fetch previous bot review threads: ${err instanceof Error ? err.message : err}`;
      core.warning(sanitize(message));
      new Logger('Autofix').warn('Failed to fetch previous bot review threads', {
        operation: 'autofix.threads',
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const result = await engine.reviewPR(
      pr,
      i,
      inputs.reviewPromptFile,
      inputs.reviewPromptExtra,
      iterTimeoutMinutes,
      previousFindings,
      undefined,
      undefined,
      previousBotComments,
      undefined,
      { forceReview: true },
    );

    if (result?.skipped) {
      // forceReview was set, so a skip should not normally happen; guard
      // defensively so a dedup short-circuit never aborts the fix loop.
      core.info(`Review deduplicated in iteration ${i + 1} — continuing`);
      continue;
    }

    if (
      !result ||
      (!result.summary && result.issues.length === 0 && result.strengths.length === 0)
    ) {
      core.warning(sanitize(`Review result empty in iteration ${i + 1} — treating as failure`));
      const entry: IterationRecord = {
        iteration: i + 1,
        status: 'needs-fix',
        summary: 'Review returned no meaningful content',
        critical: 0,
        important: 0,
        minor: 0,
      };
      history.push(entry);
      exitReason = 'no-changes';
      break;
    }

    let currentCommentIds:
      | Array<{ file: string; line: number; commentId: number; nodeId?: string }>
      | undefined;

    if (i > 0 && previousFindings.length > 0) {
      await resolveFixedComments(gh, prNumber, previousFindings, result.issues, {
        info: (msg: string) => core.info(msg),
        warn: (msg: string) => core.warning(sanitize(msg)),
      });
    }

    try {
      const reviewResult = await gh.postReview(
        prNumber,
        prHeadSha,
        result,
        config.review.inline,
        undefined,
        buildFunctionScoreOptions(config.review.showFunctionScores, pr.changedFiles),
      );
      if (reviewResult.commentIds) {
        currentCommentIds = reviewResult.commentIds;
      }
    } catch (err) {
      core.warning(sanitize(`Failed to post review: ${err instanceof Error ? err.message : err}`));
    }

    const entry: IterationRecord = {
      iteration: i + 1,
      status: 'approved',
      summary: result.summary,
      critical: result.stats?.critical ?? 0,
      important: result.stats?.important ?? 0,
      minor: result.stats?.minor ?? 0,
    };

    if (result.verdict.ready && result.stats.critical === 0 && result.stats.important === 0) {
      core.info('PR approved — all issues resolved');
      approved = true;
      exitReason = 'approved';
      entry.status = 'approved';
      history.push(entry);

      // Post-success writes are best-effort: a transient labels/comment
      // failure must not flip an approved run to failed.
      try {
        await withRetry(
          () => gh.setLabels(prNumber, ['autofix:ready'], ['autofix', 'autofix:needs-fix']),
          { operationName: 'autofix.setLabels.ready', maxRetries: 2, signal },
        );
      } catch (err) {
        core.warning(
          sanitize(
            `Failed to set autofix:ready labels on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        new Logger('Autofix').warn('Failed to set ready labels after approval', {
          operation: 'autofix.setLabels.ready',
          prNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await withRetry(() => gh.createComment(prNumber, buildReadyBody(history, prNumber)), {
          operationName: 'autofix.createComment.ready',
          maxRetries: 2,
          signal,
        });
      } catch (err) {
        core.warning(
          sanitize(
            `Failed to post ready comment on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        new Logger('Autofix').warn('Failed to post ready comment after approval', {
          operation: 'autofix.createComment.ready',
          prNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      core.info('Posted ready-to-merge notification');
      break;
    }

    entry.status = 'needs-fix';
    entry.summary = result.summary;
    history.push(entry);
    try {
      await gh.postOrUpdateComment(
        prNumber,
        REVIEW_MARKER,
        buildAutofixStatusBody(history, config.maxIterations, 'reviewing', result),
      );
    } catch (err) {
      core.warning(
        sanitize(`Failed to post review comment: ${err instanceof Error ? err.message : err}`),
      );
    }

    let contextMarkdown: string;
    try {
      contextMarkdown = await withRetry(() => gh.gatherContext({ prNumber }), {
        operationName: 'autofix.gatherContext',
        signal,
      });
    } catch (err) {
      core.setFailed(
        sanitize(
          `Failed to gather context for PR #${prNumber} in autofix iteration ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (i === 0 && operatorInstruction) {
      contextMarkdown = appendOperatorInstruction(
        contextMarkdown,
        operatorInstruction,
        operatorActor,
      );
    }
    const fixResult = await engine.runFix(
      prNumber,
      i,
      contextMarkdown,
      pr,
      iterTimeoutMinutes,
      result.issues,
    );

    if (fixResult.stuck) {
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
      core.info('Fix agent reported stuck — stopping loop');
      const currentEntry = history[history.length - 1];
      currentEntry.status = 'no-changes';
      exitReason = 'no-changes';
      break;
    }

    if (!fixResult.changesMade) {
      core.info('Fix agent made no changes — stopping loop');
      const currentEntry = history[history.length - 1];
      currentEntry.status = 'no-changes';
      exitReason = 'no-changes';
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_MARKER,
          buildAutofixStatusBody(history, config.maxIterations, 'no-changes', result),
        );
      } catch (err) {
        core.warning(
          sanitize(
            `Failed to post no-changes comment: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
      break;
    }

    const currentEntry = history[history.length - 1];
    currentEntry.status = 'fix-applied';
    currentEntry.filesChanged = fixResult.filesChanged;
    currentEntry.fixSummary = fixResult.summary;

    const commitMsg = `fix: autofix iteration ${i + 1}`;
    try {
      await exec.exec('git', ['add', '-A']);
      // The fix agent can report changes while leaving the tree clean (only
      // ignored files written, or edits identical to HEAD). Committing then
      // fails with "nothing to commit" (exit 1) — a clean tree is not a git
      // failure, so skip the commit and let the loop continue to verification
      // and the next review iteration instead of misreporting git-failure.
      const treeState = await exec.getExecOutput('git', ['status', '--porcelain'], {
        silent: true,
      });
      if (treeState.stdout.trim() === '') {
        core.info('Working tree clean after fix — skipping commit, continuing loop');
      } else {
        await exec.exec('git', ['commit', '-m', commitMsg]);
        validateRefName(pr.headRef);
        await exec.exec('git', ['push', 'origin', pr.headRef]);
        currentEntry.commitMessage = commitMsg;

        previousFindings.push({
          iteration: i + 1,
          issues: result.issues,
          fixSummary: fixResult.summary,
          filesChanged: fixResult.filesChanged,
          headSha: prHeadSha,
          commentIds: currentCommentIds?.map((c) => ({
            file: c.file,
            line: c.line,
            commentId: c.commentId,
            nodeId: c.nodeId,
          })),
        });
      }
    } catch (err) {
      core.warning(
        sanitize(
          `Git operations failed in iteration ${i + 1}: ${err instanceof Error ? err.message : err}`,
        ),
      );
      exitReason = 'git-failure';
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_MARKER,
          buildAutofixStatusBody(history, config.maxIterations, 'reviewing', result),
        );
      } catch (postErr) {
        core.warning(
          sanitize(
            `Failed to post recovery comment: ${postErr instanceof Error ? postErr.message : postErr}`,
          ),
        );
      }
      break;
    }

    try {
      await gh.postOrUpdateComment(prNumber, FIX_MARKER, buildFixBody(history));
    } catch (err) {
      core.warning(
        sanitize(`Failed to post fix comment: ${err instanceof Error ? err.message : err}`),
      );
    }

    if (inputs.runChecksAfterFix) {
      core.info('Running verification commands...');
      let steps: CheckExecution[];
      try {
        steps = parseRunChecksCommands(inputs.runChecksAfterFix, inputs.checkAllowlist);
      } catch (err) {
        core.warning(
          sanitize(
            `Verification command rejected (${err instanceof Error ? err.message : err}). Skipping verification.`,
          ),
        );
        steps = [];
      }

      const maxVerificationRetries = 2;
      for (let v = 0; v <= maxVerificationRetries; v++) {
        const { exitCode, output: checkOutput } = await runVerificationSteps(steps, signal);

        // A cancelled run must stop instead of feeding the cancelled output
        // back into the engine as ordinary verification failure. Route
        // through the graceful cancel path so history/marker/message stay
        // consistent with other cancellation exits.
        if (signal?.aborted) {
          await handleTimeoutGracefully(prNumber, history, i, config, gh, true);
          return;
        }

        if (steps.length === 0) {
          break;
        }

        if (exitCode === 0) {
          core.info('Verification passed');
          break;
        }

        core.warning(
          sanitize(
            `Verification failed (exit code ${exitCode}) in attempt ${v + 1}/${maxVerificationRetries + 1}. Output length: ${checkOutput.length} bytes`,
          ),
        );

        if (v < maxVerificationRetries) {
          core.info(
            `Feeding verification error to fix engine (retry ${v + 1}/${maxVerificationRetries})...`,
          );
          let prAgain: Awaited<ReturnType<typeof gh.getMR>>;
          let freshContextMarkdown: string;
          try {
            [prAgain, freshContextMarkdown] = await Promise.all([
              withRetry(() => gh.getMR(prNumber), { operationName: 'fix.getMR', signal }),
              withRetry(() => gh.gatherContext({ prNumber }), {
                operationName: 'fix.gatherContext',
                signal,
              }),
            ]);
          } catch (err) {
            core.warning(
              sanitize(
                `Verification refetch failed, skipping retry: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
            break;
          }
          if (i === 0 && operatorInstruction) {
            freshContextMarkdown = appendOperatorInstruction(
              freshContextMarkdown,
              operatorInstruction,
              operatorActor,
            );
          }
          const retryResult = await engine.runFix(
            prNumber,
            i,
            freshContextMarkdown,
            prAgain,
            iterTimeoutMinutes,
            result.issues,
            checkOutput,
          );

          if (!retryResult.changesMade) {
            core.info('Fix agent made no changes to address verification errors');
            break;
          }

          try {
            await exec.exec('git', ['add', '-A']);
            // Same clean-tree guard as the main iteration commit: the retry
            // agent can report changes while leaving the tree clean, and
            // "nothing to commit" must not fail verification loudly.
            const retryTreeState = await exec.getExecOutput('git', ['status', '--porcelain'], {
              silent: true,
            });
            if (retryTreeState.stdout.trim() === '') {
              core.info('Working tree clean after verification retry — skipping commit');
              break;
            }
            await exec.exec('git', ['commit', '-m', `fix: verification errors (attempt ${v + 1})`]);
            validateRefName(prAgain.headRef);
            await exec.exec('git', ['push', 'origin', prAgain.headRef]);
          } catch (err) {
            // Mirror the main push path and runFix retry handling: a lost
            // verification push must never be silently dropped, so fail loudly
            // and stop the outer loop instead of continuing with lost fixes.
            const msg = `Git operations failed during verification retry: ${err instanceof Error ? err.message : err}`;
            core.warning(sanitize(msg));
            core.setFailed(sanitize(msg));
            exitReason = 'git-failure';
            break;
          }
        }
      }
      if (exitReason === 'git-failure') {
        break;
      }
    }
  }

  if (!approved) {
    // Terminal label update is best-effort: on the needs-manual-review path
    // a transient setLabels failure must not skip the intended
    // setFailed/outputs below or propagate a generic error to index.ts.
    try {
      await withRetry(
        () =>
          gh.setLabels(prNumber, ['autofix:needs-manual-review'], ['autofix', 'autofix:needs-fix']),
        { operationName: 'autofix.setLabels.terminal', maxRetries: 2, signal },
      );
    } catch (err) {
      core.warning(
        sanitize(
          `Failed to set terminal autofix labels on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      new Logger('Autofix').warn('Failed to set terminal labels', {
        operation: 'autofix.setLabels.terminal',
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Only post max-iterations comment if we actually exhausted all iterations.
    // Other exit reasons (no-changes, git-failure) already posted their own comments.
    if (exitReason === 'exhausted') {
      try {
        await gh.createComment(
          prNumber,
          `<!-- autofix-max-iterations -->\n\n${buildAutofixStatusBody(history, config.maxIterations, 'max-iterations')}`,
        );
      } catch (err) {
        core.warning(
          sanitize(
            `Failed to post max-iterations comment: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
    }

    const reasonMsg =
      exitReason === 'no-changes'
        ? 'Fix agent could not resolve the issues automatically.'
        : exitReason === 'git-failure'
          ? 'Git operations failed during fix application.'
          : `Max iterations reached (${config.maxIterations}) or agent not approved.`;
    const errorMsg = `${reasonMsg} Needs manual review.`;
    core.setFailed(sanitize(errorMsg));
  }

  core.setOutput('approved', String(approved));
}

async function runVerificationSteps(
  steps: CheckExecution[],
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  if (steps.length === 0) {
    return { exitCode: 0, output: '' };
  }

  const chunks: string[] = [];
  let exitCode = 0;
  for (const step of steps) {
    // Per-command timeout (default 5 min) so a hung check (e.g. pnpm test
    // waiting on network) fails verification instead of blocking the runner
    // until the job is killed. Timeout surfaces as exit 124 with a clear
    // message; output is byte-capped before feedback to the fix engine.
    const { exitCode: stepExit, output } = await execWithTimeout(step.program, step.args, {
      ...(step.cwd ? { cwd: step.cwd } : {}),
      signal,
    });
    if (output) chunks.push(output);
    exitCode = stepExit;
    if (exitCode !== 0) {
      break;
    }
  }
  const output = capVerificationOutput(chunks.join('\n\n'));
  return { exitCode, output };
}

async function handleTimeoutGracefully(
  prNumber: number,
  history: IterationRecord[],
  iteration: number,
  config: AgentConfig,
  gh: PlatformAdapter,
  cancelled = false,
): Promise<void> {
  // Probe the working tree best-effort: a status failure (no git repo,
  // runner I/O error) must not mask the original timeout/cancel with an
  // unhandled rejection before the comment and setFailed below.
  let hasChanges = false;
  try {
    const status = await exec.getExecOutput('git', ['status', '--porcelain']);
    hasChanges = status.stdout.trim().length > 0;
  } catch (err) {
    core.warning(
      sanitize(
        `Timeout handler status check failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    hasChanges = false;
  }

  let commitMessage = '';
  let filesChanged: string[] = [];

  if (hasChanges) {
    try {
      const raw = await exec.getExecOutput('git', ['diff', '--name-only', 'HEAD']);
      filesChanged = raw.stdout.trim().split('\n').filter(Boolean);

      commitMessage = cancelled
        ? `fix: address review feedback (partial changes due to cancel at iteration ${iteration + 1})`
        : `fix: address review feedback (partial changes due to timeout iteration ${iteration + 1})`;
      await exec.exec('git', ['add', '-A']);
      await exec.exec('git', ['commit', '-m', commitMessage]);

      const pr = await gh.getMR(prNumber);
      validateRefName(pr.headRef);
      await exec.exec('git', ['push', 'origin', pr.headRef]);
      core.info('Successfully pushed partial changes.');
    } catch (err) {
      core.warning(
        sanitize(`Git push of partial changes failed: ${err instanceof Error ? err.message : err}`),
      );
    }
  }

  // Update history
  // NOTE: `IterationRecord.status` has no 'cancelled' member (lib type), so
  // the cancelled branch intentionally reuses 'timeout' here; the summary,
  // marker (<!-- autofix-cancelled -->), and setFailed message above carry
  // the cancel distinction for history consumers.
  history.push({
    iteration: iteration + 1,
    status: 'timeout',
    summary: cancelled
      ? 'Workflow execution cancelled. Changes partially applied.'
      : 'Workflow execution timed out. Changes partially applied.',
    critical: 0,
    important: 0,
    minor: 0,
    filesChanged,
    commitMessage,
  });

  const marker = cancelled ? '<!-- autofix-cancelled -->' : '<!-- autofix-timeout -->';
  const heading = cancelled
    ? '⚠️ **Autofix Cancelled**'
    : `⚠️ **Autofix Timed Out (limit: ${config.timeoutMinutes} minutes)**`;
  const reasonLine = cancelled
    ? 'The workflow run was cancelled.'
    : 'The workflow run has reached its timeout limit.';
  const commentBody = `${marker}
${heading}

${reasonLine}
${hasChanges ? `Some changes were partially applied to ${filesChanged.length} files and pushed to the branch.` : 'No changes were pending or staged.'}

Please run the workflow again to continue applying fixes.`;

  try {
    await gh.postOrUpdateComment(prNumber, marker, commentBody);
  } catch (err) {
    core.warning(
      sanitize(`Failed to post timeout comment: ${err instanceof Error ? err.message : err}`),
    );
  }

  core.setFailed(
    sanitize(
      cancelled
        ? 'Autofix execution cancelled before completion.'
        : `Autofix execution timed out after ${config.timeoutMinutes} minutes.`,
    ),
  );
}
