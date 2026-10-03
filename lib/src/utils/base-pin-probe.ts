/**
 * THROWAWAY PROBE FILE — created solely to exercise the review job's base-pin
 * path against a real run. Delete with the branch.
 *
 * This file is ADDED by the pull request, so it does not exist in the
 * base-pinned checkout (`.github/workflows/ai-review.yml` pins the review job's
 * checkout to `github.event.pull_request.base.sha`). It is the ENOENT condition
 * that produced the original defect: a file the deterministic secret scan
 * cannot open must be reported as UNSCANNED, never as a clean pass.
 *
 * The contents are deliberately harmless — no credential of any kind — so a
 * scanner that genuinely reads this file finds nothing and a clean pass is the
 * correct outcome. The question this file exists to answer is whether "clean"
 * here means "read and empty" or "could not read at all".
 */

/** A deliberately boring, credential-free value used as probe content. */
export const BASE_PIN_PROBE = 'base-pin-probe';

/**
 * Echo the probe value back to the caller.
 *
 * @returns The constant {@link BASE_PIN_PROBE}.
 */
export function readProbe(): string {
  return BASE_PIN_PROBE;
}