import * as core from '@actions/core';
import type { FingerprintableIssue } from './inline-fingerprint.js';
import { extractFingerprintFromBody, fingerprintForIssueFull } from './inline-fingerprint.js';
import { Logger } from './logger.js';

/**
 * Minimal prior bot-thread shape needed for auto-resolve matching (subset of
 * `ReviewThreadInfo` plus the lightweight projections built in
 * action/src/review.ts and app/src/handlers/pr-review.ts).
 * @since NEXT
 */
export interface AddressableThread {
  threadId: string;
  isResolved: boolean;
  body: string;
}

/**
 * Decide whether a prior-thread fingerprint still reproduces in the current
 * findings. Mirrors the prefix-tolerant comparison in `shouldPostFingerprint`
 * so mixed 16-char short markers and 64-char full keys match without
 * migration: exact match, full-key prefix match, or short-marker prefix of a
 * known full key all count as still-valid.
 * @param priorFingerprint - Fingerprint extracted from the prior thread body.
 * @param current - Current full-range fingerprints (mixed lengths).
 * @returns True when the prior finding still reproduces.
 * @since NEXT
 */
export function isFingerprintStillValid(priorFingerprint: string, current: Set<string>): boolean {
  if (!priorFingerprint || current.size === 0) return false;
  if (current.has(priorFingerprint)) return true;
  try {
    if (priorFingerprint.length === 64) {
      if (current.has(priorFingerprint.slice(0, 16))) return true;
      return false;
    }
    for (const entry of current) {
      if (typeof entry === 'string' && entry.length === 64 && entry.startsWith(priorFingerprint)) {
        return true;
      }
    }
  } catch {
    // Fail-open: iteration errors mean "not proven valid" — caller keeps open
    // only on explicit match, so return false here (thread resolves only when
    // the caller also built a non-empty current set successfully).
    return false;
  }
  return false;
}

/**
 * Build the current-finding fingerprint set for auto-resolve comparison.
 * Fail-open: fingerprint errors for individual issues are skipped, never throw.
 * @param currentIssues - Findings from the fresh engine review of the new head.
 * @returns Set of full + short fingerprints (possibly empty).
 * @since NEXT
 */
export function buildCurrentFingerprintSet(
  currentIssues: FingerprintableIssue[] | undefined,
): Set<string> {
  const out = new Set<string>();
  try {
    if (!Array.isArray(currentIssues)) return out;
    for (const issue of currentIssues) {
      try {
        const full = fingerprintForIssueFull(issue);
        if (typeof full === 'string' && full.length === 64) {
          out.add(full);
          out.add(full.slice(0, 16));
        }
      } catch {
        // Skip unfingerprintable issues — they can never prove a thread valid,
        // and must not break the whole resolve pass.
      }
    }
  } catch {
    // Fail-open: return whatever was collected so far.
  }
  return out;
}

/**
 * Pure diff of prior bot threads against current findings: return the
 * unresolved, fingerprinted threads whose finding no longer reproduces and is
 * therefore safe to auto-resolve. Threads that are already resolved, carry no
 * (or a malformed) fingerprint, or still match a current finding are excluded
 * (fail-open: ambiguous threads stay open).
 * @param priorThreads - Previously posted bot threads (any order).
 * @param currentIssues - Findings from the fresh engine review of the new head.
 * @returns Threads to resolve (possibly empty, never throws).
 * @since NEXT
 */
export function findAddressedThreads<T extends AddressableThread>(
  priorThreads: Iterable<T> | undefined | null,
  currentIssues: FingerprintableIssue[] | undefined,
): T[] {
  const out: T[] = [];
  try {
    if (!priorThreads) return out;
    const current = buildCurrentFingerprintSet(currentIssues);
    const FINGERPRINT_SHAPE = /^[0-9a-f]{16}([0-9a-f]{48})?$/;
    for (const thread of priorThreads) {
      try {
        if (!thread || typeof thread.threadId !== 'string' || !thread.threadId) continue;
        if (thread.isResolved === true) continue;
        const fp = extractFingerprintFromBody(typeof thread.body === 'string' ? thread.body : '');
        if (!fp || !FINGERPRINT_SHAPE.test(fp)) continue;
        // Empty current set means "nothing reproduces" only when the review
        // actually ran and returned zero inline findings; an unfingerprintable
        // current list is indistinguishable from that, so resolve is correct:
        // every fingerprinted prior thread is addressed. When the caller has
        // no confidence in the current list it must not call this function.
        if (current.size > 0 && isFingerprintStillValid(fp, current)) continue;
        out.push(thread);
      } catch {
        // Fail-open: skip ambiguous threads, keep scanning.
      }
    }
  } catch {
    // Fail-open: return whatever was collected so far.
  }
  return out;
}

/**
 * Resolve addressed bot threads via the platform adapter (fail-open).
 * Each resolve is attempted independently: per-thread failures log and the
 * thread stays open while the remaining threads are still attempted. Never
 * throws — review completion must never depend on the resolve API.
 * @param gh - Platform adapter exposing `resolveReviewThread`.
 * @param gh.resolveReviewThread - Resolves one thread by ID (fail-open on error).
 * @param priorThreads - Previously posted bot threads.
 * @param currentIssues - Findings from the fresh engine review of the new head.
 * @param logger - Optional logger (defaults to a scoped Logger + core.info).
 * @param logger.info - Info sink for resolve outcomes.
 * @param logger.warn - Warning sink for per-thread resolve failures.
 * @returns Number of threads successfully resolved.
 * @since NEXT
 */
export async function autoResolveAddressedThreads<T extends AddressableThread>(
  gh: { resolveReviewThread: (threadId: string) => Promise<void> },
  priorThreads: Iterable<T> | undefined | null,
  currentIssues: FingerprintableIssue[] | undefined,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<number> {
  let addressed: T[] = [];
  try {
    addressed = findAddressedThreads(priorThreads, currentIssues);
  } catch {
    return 0;
  }
  if (addressed.length === 0) return 0;
  const log: { info: (msg: string) => void; warn: (msg: string) => void } =
    logger ?? new Logger('auto-resolve');
  let resolved = 0;
  for (const thread of addressed) {
    try {
      await gh.resolveReviewThread(thread.threadId);
      resolved++;
      const msg = `Auto-resolved addressed inline thread ${thread.threadId} — finding absent on new head`;
      try {
        log.info(msg);
      } catch {
        // Logging must never break the resolve pass.
      }
      try {
        core.info(msg);
      } catch {
        // core.info never throws in practice; guard for exotic runners.
      }
    } catch (err) {
      const msg = `Could not auto-resolve thread ${thread.threadId} — leaving open: ${err instanceof Error ? err.message : String(err)}`;
      try {
        log.warn(msg);
      } catch {
        // ignore
      }
      try {
        core.warning(msg);
      } catch {
        // ignore
      }
    }
  }
  return resolved;
}
