/**
 * Single owner for the action-side verification runner.
 *
 * The verify-and-retry loop was implemented five times: twice in
 * `action/src/fix.ts` (`runFix`, `runAutofixLoop`), once more as
 * `runVerificationSteps`, once in `action/src/self-heal.ts`, and once in
 * `action/src/post.ts`. Each copy hand-rolled its own retry bound
 * (`const maxVerificationRetries = 2`, declared twice) and its own parse
 * failure handling, so bumping the retry count or tightening the allowlist
 * needed four coordinated edits and one was always missed.
 *
 * `lib/src/utils/verify-cycle.ts#runVerificationCycle` is the retry engine;
 * this module is the action's adapter over it. It supplies the
 * `execWithTimeout` step runner (per-command timeout, restricted child env,
 * secret scrubbing, byte cap) and returns a discriminated outcome so each
 * caller keeps its OWN terminal handling — `runFix` posts a diagnostic comment
 * and sets `changes_made`, `runAutofixLoop` drives its seven terminal reasons,
 * `post.ts` only warns, and `self-heal.ts` retries in an outer loop. Those are
 * genuinely different and must not be collapsed here.
 */
import * as core from '@actions/core';
import type { CheckExecution } from '@opencode-pr-agent/lib';
import {
  DEFAULT_ALLOWLIST,
  parseRunChecksCommands,
  runVerificationCycle,
} from '@opencode-pr-agent/lib';
import {
  capVerificationOutput,
  describeAbortKind,
  execWithTimeout,
  sanitize,
  scrubVerificationOutput,
} from './utils.js';

/** Options for {@link runActionVerification}. */
export interface ActionVerificationOptions {
  /**
   * Raw `run_checks_after_fix` command string. Ignored when {@link steps} is
   * supplied (self-heal's fixed pipeline is not a user-supplied command and
   * must not be re-serialized through the parser).
   */
  command?: string;
  /** Pre-validated steps. Mutually exclusive with {@link command}. */
  steps?: CheckExecution[];
  /** Allowed executables for {@link command}. Defaults to `DEFAULT_ALLOWLIST`. */
  allowlist?: string[];
  /**
   * Trusted base directory. MUST be the real checkout dir so `cd` targets and
   * step `cwd` values are confined against the same root they execute under.
   */
  baseDir?: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /**
   * Maximum retries AFTER the initial run. Defaults to lib's
   * `MAX_VERIFICATION_RETRIES` so the bound is owned in one place.
   */
  maxRetries?: number;
  /**
   * Feed a failed attempt's output back to the fix engine. Return true when it
   * changed files (retry), false when there is nothing more to try (stop).
   */
  runFix?: (output: string, attempt: number) => Promise<boolean>;
  /**
   * Override the per-step runner. Defaults to {@link runVerificationStep}.
   * `self-heal.ts` uses this to keep its `=== label (exit: N) ===` framing.
   */
  runStep?: (step: CheckExecution, attempt: number) => Promise<string>;
}

/** Result of {@link runActionVerification}. */
export type ActionVerificationOutcome =
  /** Every step exited 0 (or a pass was recovered by a later attempt). */
  | { kind: 'passed'; output: string; attempts: number }
  /** Steps ran and verification never went green within the retry budget. */
  | { kind: 'failed'; output: string; attempts: number }
  /**
   * The configured gate could not be parsed. Distinct from `failed` because
   * callers fail closed with a different message: a gate that cannot run is
   * not the same as a gate that ran red.
   */
  | { kind: 'rejected'; reason: string }
  /** The run signal aborted before verification could conclude. */
  | { kind: 'cancelled'; output: string; attempts: number };

/**
 * Run one verification step under the action's exec policy and throw on a
 * non-zero exit so {@link runVerificationCycle} treats it as a failed attempt.
 *
 * The thrown error's message IS the step's captured output, because the cycle
 * feeds `message` (plus any `stderr`) back to the retry callback. Output is
 * secret-scrubbed and byte-capped before it leaves this function, so neither
 * the retry prompt nor a diagnostic comment can carry a credential.
 * @param step - Validated step to execute.
 * @param signal - Abort signal forwarded to the subprocess.
 * @returns The step's captured (scrubbed, capped) output on exit 0.
 * @throws An `Error` whose message is the step output when the step exits non-zero.
 */
export async function runVerificationStep(
  step: CheckExecution,
  signal?: AbortSignal,
): Promise<string> {
  const { exitCode, output } = await execWithTimeout(step.program, step.args, {
    ...(step.cwd ? { cwd: step.cwd } : {}),
    signal,
  });
  const captured = scrubVerificationOutput(capVerificationOutput(output));
  if (exitCode !== 0) throw new Error(captured);
  return captured;
}

/**
 * Parse, run, and retry the configured verification gate through lib's single
 * verify-cycle owner.
 *
 * Only the retry engine is shared. Parse-failure text, cancellation handling,
 * and what "verification failed" means for the job (comment, label,
 * `changes_made`, terminal exit reason) stay with each caller, because those
 * differ per call site and are the caller's contract with the workflow.
 * @param options - Command/steps, allowlist, signal, retry budget, and retry callback.
 * @returns A discriminated outcome the caller maps onto its own terminal handling.
 */
export async function runActionVerification(
  options: ActionVerificationOptions,
): Promise<ActionVerificationOutcome> {
  const {
    command,
    steps: preParsed,
    allowlist = DEFAULT_ALLOWLIST,
    baseDir = process.env.GITHUB_WORKSPACE || process.cwd(),
    signal,
    maxRetries,
    runFix,
    runStep,
  } = options;

  let steps = preParsed;
  if (!steps) {
    if (!command) return { kind: 'rejected', reason: 'run_checks_after_fix must not be empty' };
    try {
      steps = parseRunChecksCommands(command, allowlist, baseDir);
    } catch (err) {
      return {
        kind: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const execute = runStep ?? ((step: CheckExecution) => runVerificationStep(step, signal));
  let rejectionReason: string | undefined;
  try {
    const result = await runVerificationCycle({
      command: command ?? '',
      steps,
      allowlist,
      baseDir,
      signal,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(runFix ? { runFix } : {}),
      runStep: execute,
      logger: {
        info: (msg: string) => core.info(msg),
        warn: (msg: string) => {
          // lib reports a rejected gate here. Recorded (not thrown) so the
          // cycle still returns a result; the caller maps it to the fail-closed
          // parse-rejection terminal.
          if (msg.startsWith('Verification command rejected:')) {
            rejectionReason = msg.slice('Verification command rejected:'.length).trim();
          }
          core.warning(sanitize(msg));
        },
      },
    });
    const output = scrubVerificationOutput(capVerificationOutput(result.output));
    if (result.passed) return { kind: 'passed', output, attempts: result.attempts };
    if (rejectionReason !== undefined) return { kind: 'rejected', reason: rejectionReason };
    // A non-zero attempt count means steps actually ran; zero means the cycle
    // bailed before the first attempt (parse rejection or an already-aborted
    // signal). Cancellation is reported separately so callers can route to
    // their graceful-cancel terminal instead of a verification failure.
    if (signal?.aborted) {
      const kind = signal.reason === undefined ? 'cancelled' : describeAbortKind(signal.reason);
      return {
        kind: 'cancelled',
        output: output || `Verification ${kind} before starting the next command.`,
        attempts: result.attempts,
      };
    }
    return { kind: 'failed', output, attempts: result.attempts };
  } catch (err) {
    // `runVerificationCycle` rethrows a caller-signal abort (via
    // `throwIfAborted`); cancellation is not a verification failure.
    if (signal?.aborted) {
      const kind = signal.reason === undefined ? 'cancelled' : describeAbortKind(signal.reason);
      return {
        kind: 'cancelled',
        output: `Verification ${kind} before starting the next command.`,
        attempts: 0,
      };
    }
    throw err;
  }
}
