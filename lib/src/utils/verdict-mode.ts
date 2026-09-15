import * as core from '@actions/core';
import { VERDICT_MODES, type VerdictMode } from '../types/index.js';

export type { VerdictMode };
export { VERDICT_MODES };

/**
 * Reasoning strings marking a failed (not genuine) review pass. A result
 * carrying one of these must never auto-approve or request changes.
 * Single source of truth shared by the review engine and review gating so
 * the two cannot drift when a sentinel is added or reworded.
 * @since NEXT
 */
export const VERDICT_FAILURE_SENTINELS: ReadonlySet<string> = new Set<string>([
  'Review execution failed',
  'Failed to parse review output',
  'Review output could not be parsed',
  'All review agents failed',
  'All review batches failed',
]);

/**
 * Normalize a raw `verdict_mode` value (fail-open to `'comment'`).
 * Single source of truth for the allowlist so action inputs, repo config,
 * and review gating cannot drift.
 * @param value - Raw mode value from config/input.
 * @returns Normalized mode.
 * @since NEXT
 */
export function normalizeVerdictMode(value: unknown): VerdictMode {
  if (typeof value !== 'string') return 'comment';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'approve' || normalized === 'request-changes') return normalized;
  if (normalized !== '' && normalized !== 'comment') {
    core.warning(
      `Ignoring invalid verdict_mode "${String(value)}". Must be "comment", "approve", or "request-changes"; falling back to "comment".`,
    );
  }
  return 'comment';
}
