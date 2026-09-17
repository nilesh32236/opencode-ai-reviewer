/**
 * Single owner for the verify-and-retry cycle.
 *
 * `app/src/handlers/autofix.ts#handleAutofixLoop` embeds a ~140-line
 * verification sub-loop (parse → install → retry ≤ 2 → runFix → commit/push)
 * that duplicates the review→fix→verify→push twin in `action/src/fix.ts`.
 * Any retry-count, clean-tree-guard, or allowlist fix needed edits in both
 * places. New verify flows must use {@link runVerificationCycle} with a
 * single options object so retry semantics live in one place.
 */

import { type CheckExecution, DEFAULT_ALLOWLIST, parseRunChecksCommands } from './validation.js';

/** Maximum verification retries (initial run + 2 retries). */
export const MAX_VERIFICATION_RETRIES = 2;

/** Options for {@link runVerificationCycle}. */
export interface VerificationCycleOptions {
  /** Raw `run_checks_after_fix` command string (may chain with `&&` / `cd`). */
  command: string;
  /** Allowed executables. Defaults to `DEFAULT_ALLOWLIST`. */
  allowlist?: string[];
  /** Run one validated step; resolves stdout on success. */
  runStep: (step: CheckExecution, attempt: number) => Promise<string>;
  /** Feed verification output back to the fix engine; return true when it changed files. */
  runFix?: (output: string, attempt: number) => Promise<boolean>;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Maximum retries after the initial run. Defaults to 2. */
  maxRetries?: number;
  /** Optional logger. */
  logger?: { info(msg: string): void; warn(msg: string): void };
}

/** Result of {@link runVerificationCycle}. */
export interface VerificationCycleResult {
  /** True when verification passed (or no steps were configured). */
  passed: boolean;
  /** Accumulated stdout + error output across attempts. */
  output: string;
  /** Number of verification attempts executed. */
  attempts: number;
}

/**
 * Parse a verification command and run it with bounded retries, feeding
 * failures back to the fix engine between attempts.
 *
 * @param options - Single options object (command, runners, retries).
 * @returns Whether verification passed plus accumulated output.
 */
export async function runVerificationCycle(
  options: VerificationCycleOptions,
): Promise<VerificationCycleResult> {
  const {
    command,
    allowlist = DEFAULT_ALLOWLIST,
    runStep,
    runFix,
    signal,
    maxRetries = MAX_VERIFICATION_RETRIES,
    logger,
  } = options;
  let steps: CheckExecution[];
  try {
    steps = parseRunChecksCommands(command, allowlist);
  } catch (err) {
    logger?.warn(
      `Verification command rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { passed: false, output: '', attempts: 0 };
  }
  if (steps.length === 0) return { passed: true, output: '', attempts: 0 };

  let output = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) return { passed: false, output, attempts: attempt };
    signal?.throwIfAborted();
    let checkOutput = '';
    try {
      for (const step of steps) {
        signal?.throwIfAborted();
        checkOutput += await runStep(step, attempt);
      }
      logger?.info('Verification passed');
      return { passed: true, output: output + checkOutput, attempts: attempt + 1 };
    } catch (err) {
      if (signal?.aborted) return { passed: false, output, attempts: attempt + 1 };
      const extra =
        typeof err === 'object' && err !== null && 'stderr' in err
          ? String((err as { stderr?: unknown }).stderr ?? '')
          : '';
      const message = err instanceof Error ? err.message : String(err);
      checkOutput += `${message}\n${extra}`;
      output += checkOutput;
      logger?.warn(`Verification failed (attempt ${attempt + 1}/${maxRetries + 1}): ${message}`);
      if (attempt < maxRetries && runFix) {
        try {
          signal?.throwIfAborted();
          const changed = await runFix(checkOutput, attempt);
          if (!changed) {
            logger?.info('Fix agent made no changes to address verification errors');
            return { passed: false, output, attempts: attempt + 1 };
          }
        } catch (innerErr) {
          if (signal?.aborted) return { passed: false, output, attempts: attempt + 1 };
          logger?.warn(
            `Verification retry failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
          );
          return { passed: false, output, attempts: attempt + 1 };
        }
      } else if (attempt >= maxRetries) {
        return { passed: false, output, attempts: attempt + 1 };
      }
    }
  }
  return { passed: false, output, attempts: maxRetries + 1 };
}
