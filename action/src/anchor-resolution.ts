/**
 * Publication-time anchor resolution for the Action's review path.
 *
 * A finding is a claim about a line of a file at a commit. By the time it is
 * published nothing binds those three together, so a line number can point at
 * unrelated code and be read as if it did not. On the previous head every one
 * of the four P1 anchors was wrong against the reviewed tree, and the review's
 * own two artifacts disagreed by 135 lines about where one function lived.
 *
 * This resolves each anchor against the content the review was actually
 * computed from — the proposed blobs staged by the workflow, falling back to
 * the checkout for files the PR did not touch — and marks anything that does
 * not line up as a stale anchor.
 *
 * Two properties matter more than the feature itself:
 *
 *   1. It never drops a finding. A real defect reported against a line that
 *      has since moved is still worth reading; it just has to be labelled as
 *      evidence about a past revision.
 *   2. It never claims a verification it did not perform. Only anchors whose
 *      captured source line was actually compared count towards
 *      `anchorsChecked`, so an unverified anchor cannot inflate that number
 *      into false assurance.
 */

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveIssueAnchors } from '@opencode-pr-agent/lib';
import type { ReviewResult } from '@opencode-pr-agent/lib';

/**
 * Build a reader for file content at the reviewed commit.
 *
 * Proposed content is preferred for exactly the reason the secret scan prefers
 * it: the review checkout is pinned to the base sha, so a file this PR added
 * is missing there and a file it modified holds pre-change bytes. Reading the
 * checkout first would resolve anchors against the wrong revision for every
 * changed file — the same class of error as a stale line number, one level up.
 *
 * @param rootDir - Checkout root, used as the fallback.
 * @returns A reader that resolves proposed content before the checkout.
 */
export function createAnchorReader(rootDir: string): (file: string) => Promise<string | undefined> {
  const proposedRoot = process.env.OPENCODE_PROPOSED_CONTENT_DIR?.trim();
  const proposed = proposedRoot ? path.resolve(proposedRoot) : undefined;

  return async (file: string): Promise<string | undefined> => {
    if (!file || path.isAbsolute(file)) return undefined;

    if (proposed) {
      const candidate = path.resolve(proposed, file);
      // A finding path must stay inside the scan-only root; anything else is
      // not ours to read.
      if (candidate.startsWith(proposed + path.sep) && existsSync(candidate)) {
        try {
          return await fs.readFile(candidate, 'utf-8');
        } catch {
          // Fall through to the checkout rather than reporting the anchor
          // stale on a transient read error.
        }
      }
    }

    const checkout = path.resolve(rootDir, file);
    if (!checkout.startsWith(path.resolve(rootDir) + path.sep)) return undefined;
    try {
      return await fs.readFile(checkout, 'utf-8');
    } catch {
      return undefined;
    }
  };
}

/**
 * Resolve every finding's anchor and fold the counts back into the trust block.
 *
 * Mutates and returns the result so the call site reads as one step at
 * publication. Never throws: a failure here degrades to "no anchors were
 * verified", which the trust block then states.
 *
 * @param result - The result about to be published.
 * @param headSha - Commit the findings were computed against.
 * @param rootDir - Checkout root for the fallback reader.
 * @returns The same result, with anchor statuses and updated trust counts.
 */
export async function applyAnchorResolution(
  result: ReviewResult,
  headSha: string,
  rootDir: string,
): Promise<ReviewResult> {
  if (!result.trust || result.issues.length === 0) return result;
  try {
    const counts = await resolveIssueAnchors(result.issues, headSha, createAnchorReader(rootDir));
    result.trust = {
      ...result.trust,
      anchorsChecked: counts.checked,
      anchorsRangeChecked: counts.rangeChecked,
      staleAnchors: counts.stale,
    };
  } catch {
    // Leave the block at zero verified rather than guessing. A zero is a
    // truthful "we did not check"; a wrong positive is the thing this whole
    // mechanism exists to prevent.
    result.trust = { ...result.trust, anchorsChecked: 0, staleAnchors: 0 };
  }
  return result;
}
