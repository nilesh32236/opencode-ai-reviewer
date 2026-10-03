/**
 * THROWAWAY CONTROL FILE — created solely to exercise the review job's
 * base-pin path against a real run, on a branch based at `main`.
 * Delete with the branch.
 *
 * This file is ADDED by the pull request, so it does not exist in the
 * base-pinned checkout (`.github/workflows/ai-review.yml` pins the review job's
 * checkout to `github.event.pull_request.base.sha`). It is the ENOENT condition
 * behind the original defect: a file the deterministic secret scan cannot open
 * must be reported as UNSCANNED, never as a clean pass.
 *
 * Contents are deliberately credential-free, so a scanner that genuinely reads
 * this file finds nothing and a clean pass is the CORRECT outcome. The question
 * is whether "clean" here means "read and empty" or "could not read at all".
 */

/** A deliberately boring, credential-free value used as probe content. */
export const BASE_PIN_CONTROL = 'base-pin-control';

/**
 * Echo the control value back to the caller.
 *
 * @returns The constant {@link BASE_PIN_CONTROL}.
 */
export function readControl(): string {
  return BASE_PIN_CONTROL;
}