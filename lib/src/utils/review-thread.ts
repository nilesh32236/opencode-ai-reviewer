import * as core from '@actions/core';
import type { PlatformAdapter } from '../platform/adapter.js';

/**
 * Raw review comment shape used across window fetches and direct by-id fetches.
 * Mirrors the GitHub REST review-comment payload fields the thread
 * reconstruction relies on.
 */
export interface ThreadComment {
  id: number;
  body: string;
  user?: { login?: string; type?: string };
  path?: string;
  line?: number;
  diff_hunk?: string;
  in_reply_to_id?: number;
  /** Commit the comment was made against (GitHub review comments carry it). */
  commit_id?: string;
}

/**
 * Runtime guard for a single external review-comment payload. The platform
 * adapter returns untyped API data, so `id`/`body` are validated before the
 * value enters the typed thread reconstruction — a shape change warns and
 * skips instead of failing silently downstream.
 * @param value - The unknown payload to test.
 * @returns True when the value has the ThreadComment shape.
 */
export function isThreadComment(value: unknown): value is ThreadComment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'number' && typeof record.body === 'string';
}

/**
 * Filter an unknown external list down to valid thread comments, warning on
 * each skipped item so API shape changes stay visible in logs.
 * @param value - The unknown list payload from the platform adapter.
 * @returns Only the items passing {@link isThreadComment}.
 */
export function toThreadCommentArray(value: unknown): ThreadComment[] {
  if (!Array.isArray(value)) {
    core.warning(`Expected a review-comment list, got ${typeof value} — ignoring`);
    return [];
  }
  const valid: ThreadComment[] = [];
  for (const item of value) {
    if (isThreadComment(item)) {
      valid.push(item);
    } else {
      core.warning('Skipping malformed review comment (missing numeric id or string body)');
    }
  }
  return valid;
}

/** Result of reconstructing a review comment thread. */
export interface ReviewThreadResult {
  /**
   * Ancestor chain from root to trigger (root-first), including any comments
   * recovered by direct by-id fetches when they fell outside the window.
   */
  chain: ThreadComment[];
  /**
   * Full thread subtree — every comment that directly or transitively replies to
   * a comment in the ancestor chain (sibling replies and nested branches) — sorted
   * ascending by id.
   */
  comments: ThreadComment[];
}

/**
 * Reconstruct a review comment thread on a merge request.
 *
 * Fetches the bounded comment window via the platform adapter, walks the
 * in_reply_to_id chain from the trigger up to the root with a cycle guard
 * (in_reply_to_id comes from external API data and may be malformed), and
 * direct-fetches any comments that fall outside the window so a deep/old thread
 * is never silently truncated. Ancestors already in the window are resolved from
 * the in-memory map without an extra API call.
 *
 * The window is then expanded to the full thread subtree with a single-pass BFS
 * (queue-based, O(n)) so sibling and nested replies reach the caller, matching
 * the intent that prior bot/user turns are never dropped.
 *
 * A single failed direct fetch returns the partially gathered chain instead of
 * dropping the whole thread, so callers can still answer with available context.
 *
 * Shared by both the reply flow (GitHubHelper.getReviewCommentThread) and the
 * @mention conversation flow (gatherReviewCommentThread) so the bug-prone chain
 * walk logic cannot drift between the two implementations.
 *
 * @param gh - Platform adapter.
 * @param prNumber - Merge request number.
 * @param commentId - Triggering review comment ID.
 * @param options - Window bounds (perPage/maxPages/direction). Callers choose
 * their own bounds; 'desc' keeps freshly-posted triggers in-window on busy PRs.
 * @param options.perPage - Items per page.
 * @param options.maxPages - Maximum pages to fetch.
 * @param options.direction - Sort direction.
 * @param signal - Optional AbortSignal to cancel the underlying API requests.
 * @returns The reconstructed ancestor chain and full subtree.
 */
export async function gatherReviewThread(
  gh: PlatformAdapter,
  prNumber: number,
  commentId: number,
  options: { perPage?: number; maxPages?: number; direction?: 'asc' | 'desc' } = {},
  signal?: AbortSignal,
): Promise<ReviewThreadResult> {
  let rawComments: ThreadComment[];
  try {
    rawComments = toThreadCommentArray(await gh.listReviewComments(prNumber, options, signal));
  } catch (err) {
    core.warning(
      `Failed to gather review comment thread: ${err instanceof Error ? err.message : err}`,
    );
    return { chain: [], comments: [] };
  }

  // Index once for O(1) lookups (avoids repeated rawComments.find in loops).
  const byId = new Map<number, ThreadComment>();
  for (const c of rawComments) {
    if (typeof c.id === 'number') byId.set(c.id, c);
  }

  // Walk the in_reply_to_id chain from the trigger up to the root with a cycle
  // guard (in_reply_to_id comes from external API data and may be malformed).
  const chain: ThreadComment[] = [];
  const visited = new Set<number>();
  let currentId: number | undefined = commentId;
  let missingId: number | undefined;
  while (currentId) {
    const comment = byId.get(currentId);
    if (!comment) {
      missingId = currentId;
      break;
    }
    if (visited.has(currentId)) break;
    visited.add(currentId);
    chain.unshift(comment);
    currentId = comment.in_reply_to_id;
  }

  // The trigger or an ancestor fell outside the window: fetch the missing chain
  // by ID so a deep/old thread is never silently truncated. Ancestors already in
  // the window are resolved from the in-memory map without an API call, and a
  // single failed fetch returns the partially gathered chain instead of dropping
  // the whole thread.
  if (missingId !== undefined) {
    const missing: ThreadComment[] = [];
    let ancestorId: number | undefined = missingId;
    while (ancestorId) {
      if (visited.has(ancestorId)) break;
      visited.add(ancestorId);
      const known = byId.get(ancestorId);
      let comment: ThreadComment;
      if (known) {
        comment = known;
      } else {
        try {
          const fetched = await gh.getReviewComment(prNumber, ancestorId, signal);
          if (!isThreadComment(fetched)) {
            core.warning(
              `Fetched comment ${ancestorId} has an unexpected shape — returning partial thread`,
            );
            break;
          }
          comment = fetched;
          byId.set(comment.id, comment);
        } catch (err) {
          core.warning(
            `Failed to fetch comment ${ancestorId} for review thread — returning partial thread: ${
              err instanceof Error ? err.message : err
            }`,
          );
          break;
        }
      }
      missing.push(comment);
      ancestorId = comment.in_reply_to_id;
    }
    // missing is leaf-to-root; prepend reversed to keep the chain root-first.
    chain.unshift(...missing.reverse());
  }

  if (chain.length === 0) {
    return { chain: [], comments: [] };
  }

  // Include the whole thread subtree: a queue-based BFS over windowed comments
  // indexed by in_reply_to_id, seeded with the chain IDs (single-pass O(n)).
  // The chain itself may hold direct-fetched comments outside the window, so the
  // final list is resolved through byId and sorted ascending by id. Only the
  // bounded window is scanned, so out-of-window sibling replies are omitted.
  const childrenByParent = new Map<number, ThreadComment[]>();
  for (const c of rawComments) {
    if (c.in_reply_to_id === undefined) continue;
    const children = childrenByParent.get(c.in_reply_to_id);
    if (children) {
      children.push(c);
    } else {
      childrenByParent.set(c.in_reply_to_id, [c]);
    }
  }
  const threadIds = new Set<number>(chain.map((c) => c.id));
  const queue = [...threadIds];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    const children = childrenByParent.get(parentId);
    if (!children) continue;
    for (const child of children) {
      if (threadIds.has(child.id)) continue;
      threadIds.add(child.id);
      queue.push(child.id);
    }
  }
  const comments = [...threadIds]
    .map((id) => byId.get(id))
    .filter((c): c is ThreadComment => c !== undefined)
    .sort((a, b) => a.id - b.id);

  return { chain, comments };
}
