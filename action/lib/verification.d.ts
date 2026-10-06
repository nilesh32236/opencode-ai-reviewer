import type { CheckExecution } from '@opencode-pr-agent/lib';
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
{
    kind: 'passed';
    output: string;
    attempts: number;
}
/** Steps ran and verification never went green within the retry budget. */
 | {
    kind: 'failed';
    output: string;
    attempts: number;
}
/**
 * The configured gate could not be parsed. Distinct from `failed` because
 * callers fail closed with a different message: a gate that cannot run is
 * not the same as a gate that ran red.
 */
 | {
    kind: 'rejected';
    reason: string;
}
/** The run signal aborted before verification could conclude. */
 | {
    kind: 'cancelled';
    output: string;
    attempts: number;
};
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
export declare function runVerificationStep(step: CheckExecution, signal?: AbortSignal): Promise<string>;
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
export declare function runActionVerification(options: ActionVerificationOptions): Promise<ActionVerificationOutcome>;
