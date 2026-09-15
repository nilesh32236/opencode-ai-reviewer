import * as core from '@actions/core';
import { VERDICT_MODES, type VerdictMode } from '../types/index.js';

export type { VerdictMode };
export { VERDICT_MODES };

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
  if (
    normalized === VERDICT_MODES[1] ||
    normalized === VERDICT_MODES[2]
  )
    return normalized;
  if (normalized !== '' && normalized !== VERDICT_MODES[0]) {
    core.warning(
      `Ignoring invalid verdict_mode "${String(value)}". Must be "comment", "approve", or "request-changes"; falling back to "comment".`,
    );
  }
  return 'comment';
}
