/**
 * Jev Score-ranked context trim (Module 2).
 *
 * When `JEV_ENABLED=true`, MCP context entries are scored for relevance to
 * the review-task query with Jev `score` questions, then sorted by score
 * descending before the existing `trimToTokenBudget` — so the same token
 * budget keeps the most relevant context. Only reorders within the existing
 * budget; never increases tokens sent.
 *
 * Fail-open contract (never throws into the caller):
 * - `JEV_ENABLED!=true` → input returned unchanged (same reference, no HTTP).
 * - No API key / transport / API / parse failure → entries keep their
 *   existing order and `relevance` values; the caller proceeds exactly as
 *   without Jev.
 * - Partial success applies: usable scores reorder, unavailable entries keep
 *   their heuristic `relevance` (benefit of the doubt above Jev-low entries).
 *
 * Bounded: at most `JEV_CONTEXT_RANK_MAX_ENTRIES` entries are submitted per
 * call (one Jev batch), reusing Module 1's batching (≤20/batch), timeouts,
 * circuit breaker, and strict parsing. Large contexts do not fan out.
 *
 * External-sharing note: entry excerpts (truncated, secret-shaped text
 * redacted — see `buildRelevanceQuestion`) leave the repo boundary when
 * enabled. User-facing disclosure lives in the README Configuration
 * Reference (`jev_enabled` row).
 */

import type { MCPContextEntry } from '../types/index.js';
import {
  type JevCallOptions,
  type JevRelevanceProvider,
  RestJevRelevanceProvider,
  isJevEnabled,
} from '../utils/jev-client.js';
import { Logger } from '../utils/logger.js';

/**
 * Maximum context entries submitted to Jev per `queryContext` call. Entries
 * beyond the cap (by existing heuristic order) keep their `relevance` and
 * relative order. One batch keeps worst-case added latency to a single Jev
 * attempt (`maxRetries: 1`, `JEV_TIMEOUT_MS` per attempt).
 */
export const JEV_CONTEXT_RANK_MAX_ENTRIES = 20;

/** Options accepted by {@link rankContextEntries}. */
export interface RankContextOptions {
  /** Logger for diagnostics (defaults to a module logger). */
  logger?: Logger;
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout override (ms). */
  timeoutMs?: number;
  /** Model override (defaults to `JEV_MODEL` / free tier). */
  model?: string;
  /** Entry cap override (defaults to `JEV_CONTEXT_RANK_MAX_ENTRIES`). */
  maxEntries?: number;
  /**
   * Relevance provider override (tests / future SDK plug-in). Defaults to
   * the shared REST provider; `queryContext` never passes one today.
   */
  provider?: JevRelevanceProvider;
}

const moduleLogger = new Logger('jev-context-rank');

/** Shared REST provider used when callers do not inject their own. */
const defaultRelevanceProvider = new RestJevRelevanceProvider();

/**
 * Re-rank MCP context entries by Jev relevance to `query`. Usable Jev
 * scores replace the heuristic `relevance` in place; the returned array is
 * stably sorted by relevance descending so the existing `trimToTokenBudget`
 * keeps the most relevant context within the same budget. Never throws:
 * any failure returns the input unchanged.
 *
 * @param entries - Context entries in existing heuristic order.
 * @param query - Review-task query the relevance is judged against.
 * @param options - Rank options (logger/fetch/model/timeout/cap/provider overrides).
 * @returns Re-ranked entries (new array, same objects), or the input unchanged when Jev is disabled/unavailable.
 */
export async function rankContextEntries(
  entries: MCPContextEntry[],
  query: string,
  options: RankContextOptions = {},
): Promise<MCPContextEntry[]> {
  const logger = options.logger ?? moduleLogger;
  try {
    if (!isJevEnabled()) {
      return entries;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return entries;
    }
    const cap = options.maxEntries ?? JEV_CONTEXT_RANK_MAX_ENTRIES;
    const head = entries.slice(0, Math.max(0, cap));
    if (head.length === 0) {
      return entries;
    }
    const provider = options.provider ?? defaultRelevanceProvider;
    const callOptions: JevCallOptions = {
      logger,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      model: options.model,
    };
    const assessments = await provider.scoreRelevance(
      head.map((entry) => entry.content),
      query,
      callOptions,
    );
    let applied = 0;
    head.forEach((entry, index) => {
      const assessment = assessments[index];
      if (assessment && !assessment.unavailable) {
        entry.relevance = assessment.score;
        applied++;
      }
    });
    if (applied === 0) {
      // Total failure: no usable signal from any entry — return the input
      // unchanged so order and relevance match the disabled path exactly.
      return entries;
    }
    logger.info(
      `Jev context rank: applied ${applied}/${head.length} relevance scores ` +
        `(cap ${cap}, ${entries.length - head.length} entries beyond cap unchanged)`,
    );
    // Stable descending sort: scored entries float by Jev score, unscored
    // entries (heuristic relevance or beyond-cap) keep relative order.
    return [...entries].sort((a, b) => b.relevance - a.relevance);
  } catch (err) {
    logger.warn(
      `Jev context rank failed (fail-open, keeping existing order): ${err instanceof Error ? err.message : String(err)}`,
    );
    return entries;
  }
}
