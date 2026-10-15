import type { ReviewIssue, ReviewResult, ReviewThreadInfo } from '@opencode-pr-agent/lib';
import { MAX_VERIFICATION_EXCERPT_CHARS, truncateToCodePoints } from './utils.js';

/**
 * Focused reuse helpers extracted from `fix.ts` (god-module split, step 1).
 * `fix.ts` re-exports everything here so existing import paths keep working.
 */

/**
 * Parse a finding severity from a posted inline body. Posted bodies render as
 * `<badge> **SEVERITY**: message`, so reuse recovers the original bucket
 * instead of defaulting everything to one level.
 * @param body - Posted inline comment body.
 * @returns Parsed severity (defaults to 'important').
 */
export function parseReusedSeverity(body: string): ReviewIssue['severity'] {
  const raw = String(body ?? '');
  const badge = raw.match(/^\s*(?:🔴|🔵|🟡)?\s*\*\*(critical|important|minor)\*\*/i);
  const level = badge?.[1]?.toLowerCase();
  if (level === 'critical' || level === 'important' || level === 'minor') return level;
  const text = raw.toLowerCase();
  if (text.includes('🔴')) return 'critical';
  if (text.includes('🔵')) return 'minor';
  return 'important';
}

/**
 * Bodies that indicate the previous review never produced usable findings
 * (LLM timeout, empty stub). Reusing them would loop on the same failure the
 * issue reports, so they force a fresh review instead.
 * @param body - Posted bot thread body.
 * @returns True when the body looks like a timeout/empty stub.
 */
export function isReviewStubBody(body: string): boolean {
  const text = String(body ?? '').toLowerCase();
  if (!text.trim()) return true;
  return (
    text.includes('review timed out') ||
    text.includes('review timeout') ||
    text.includes('review result empty') ||
    text.includes('no meaningful content')
  );
}

/**
 * Strip fingerprint markers and HTML comments from a posted body so the
 * reused finding message stays readable for the fix agent.
 * @param body - Posted inline comment body.
 * @returns Cleaned message text (truncated to `MAX_VERIFICATION_EXCERPT_CHARS` chars).
 */
export function cleanReusedBody(body: string): string {
  const cleaned = String(body ?? '')
    .replace(/<!--\s*inline-fp:[0-9a-f]{16}\s*-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const truncated = truncateToCodePoints(cleaned, MAX_VERIFICATION_EXCERPT_CHARS);
  return truncated.length < cleaned.length ? `${truncated}…` : cleaned;
}

/**
 * Rehydrate fixable findings from head-current bot threads. Only unresolved
 * threads with usable (non-stub) bodies become issues; resolved threads are
 * already fixed and must not reseed the fix phase.
 * @param threads - Bot review threads (already filtered to the bot author).
 * @param headSha - Current PR head SHA (used only for the summary line).
 * @returns Rehydrated ReviewResult, or null when nothing usable remains.
 */
export function rehydrateReviewResultFromBotThreads(
  threads: ReviewThreadInfo[],
  headSha: string,
): ReviewResult | null {
  const issues: ReviewIssue[] = [];
  for (const t of threads) {
    if (t.isResolved) continue;
    const fc = t.firstComment;
    if (!fc) continue;
    if (isReviewStubBody(fc.body)) continue;
    const message = cleanReusedBody(fc.body);
    if (!message) continue;
    const line = typeof fc.lineNumber === 'number' && fc.lineNumber > 0 ? fc.lineNumber : 0;
    issues.push({
      type: 'issue',
      severity: parseReusedSeverity(fc.body),
      file: fc.filePath,
      line,
      message,
      inline: line > 0,
      previouslyReported: true,
    });
  }
  if (issues.length === 0) return null;
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const important = issues.filter((i) => i.severity === 'important').length;
  const minor = issues.filter((i) => i.severity === 'minor').length;
  const ready = critical === 0 && important === 0;
  const shortSha = String(headSha ?? '').slice(0, 7) || 'unknown';
  return {
    summary: `Reusing head-current bot review on ${shortSha} (${issues.length} open finding(s)) — skipped fresh review for iteration 1.`,
    verdict: {
      ready,
      reasoning: ready
        ? 'Reused review reports no blocking findings.'
        : 'Reused head-current review still reports open findings.',
      autoFixable: false,
      confidence: 'medium',
    },
    strengths: [],
    issues,
    stats: { total: issues.length, critical, important, minor },
  };
}

/**
 * Head-current, non-stub, unresolved subset of bot threads eligible for
 * reuse. Single source of truth shared by {@link findReusableHeadCurrentReview}
 * and the skipped-postReview id mapping so stale-head and stub-thread comment
 * IDs never leak into fix-progress tracking.
 * @param threads - Bot review threads for the PR.
 * @param headSha - Current PR head SHA.
 * @param commitByCommentId - Optional databaseId → commit SHA map built from
 * `listReviewComments` (each record's `commit_id`).
 * @returns Threads anchored to the current head SHA.
 */
export function filterHeadCurrentReuseThreads(
  threads: ReviewThreadInfo[],
  headSha: string,
  commitByCommentId?: Map<number, string>,
): ReviewThreadInfo[] {
  const head = String(headSha ?? '').toLowerCase();
  if (!head || !Array.isArray(threads) || threads.length === 0) return [];
  return threads.filter((t) => {
    if (t.isResolved || !t.firstComment) return false;
    if (isReviewStubBody(t.firstComment.body ?? '')) return false;
    const direct = String(t.firstComment.commitId ?? '').toLowerCase();
    if (direct) return direct === head;
    if (commitByCommentId) {
      const mapped = String(commitByCommentId.get(t.firstComment.databaseId) ?? '').toLowerCase();
      if (mapped) return mapped === head;
    }
    return false;
  });
}

/**
 * Ready verdict for a head-current bot review that carries zero inline
 * threads (clean review or body-only findings). Lets `/fix` skip the fresh
 * `engine.reviewPR` LLM pass instead of repaying it for an already-clean head.
 * @param headSha - Current PR head SHA (used only for the summary line).
 * @returns ReviewResult with zero issues and a ready verdict.
 */
export function buildCleanReusedReviewResult(headSha: string): ReviewResult {
  const shortSha = String(headSha ?? '').slice(0, 7) || 'unknown';
  return {
    summary: `Reusing head-current bot review on ${shortSha} (0 open finding(s)) — skipped fresh review for iteration 1.`,
    verdict: {
      ready: true,
      reasoning: 'Reused head-current bot review reports no open findings.',
      autoFixable: false,
      confidence: 'medium',
    },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
  };
}

/**
 * Decide whether iteration 1 can reuse an existing bot review instead of
 * paying for a fresh `engine.reviewPR` LLM pass. Head-current means at least
 * one unresolved, non-stub bot thread is anchored to the current head SHA
 * (via `firstComment.commitId`, or via `listReviewComments` commit
 * correlation when the adapter does not populate it).
 * @param threads - Bot review threads for the PR.
 * @param headSha - Current PR head SHA.
 * @param commitByCommentId - Optional databaseId → commit SHA map built from
 * `listReviewComments` (each record's `commit_id`).
 * @returns Rehydrated ReviewResult when reuse applies, else null.
 */
export function findReusableHeadCurrentReview(
  threads: ReviewThreadInfo[],
  headSha: string,
  commitByCommentId?: Map<number, string>,
): ReviewResult | null {
  const headCurrent = filterHeadCurrentReuseThreads(threads, headSha, commitByCommentId);
  if (headCurrent.length === 0) return null;
  return rehydrateReviewResultFromBotThreads(headCurrent, headSha);
}
