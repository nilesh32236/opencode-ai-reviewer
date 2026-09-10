import type { ReviewEffort } from '../types/index.js';

/** Concrete settings contributed by a review effort preset. */
export interface ReviewEffortPreset {
  /** Maximum files per sub-agent batch. */
  batchSize: number;
  /** Maximum lines per file included in context. */
  maxLinesPerFile: number;
  /** Whether the meta-verification pass runs. */
  enableMetaVerification: boolean;
}

/**
 * Preset mapping for `review.effort` / `review_effort`.
 * - `lite`: smaller batches, lower maxLinesPerFile, meta-verification off.
 * - `balanced`: current defaults (identity — no overrides applied).
 */
export const REVIEW_EFFORT_PRESETS: Record<ReviewEffort, ReviewEffortPreset> = {
  lite: { batchSize: 2, maxLinesPerFile: 200, enableMetaVerification: false },
  balanced: { batchSize: 3, maxLinesPerFile: 500, enableMetaVerification: false },
};

/**
 * Normalize a raw effort value (action input or config file) to a known preset.
 * Unknown or unset values return null so callers fall back to current defaults.
 * @param input - Raw effort value (already trimmed/lowercased by callers or not).
 * @returns The preset name, or null when unset/unknown.
 */
export function parseReviewEffort(input: unknown): ReviewEffort | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  if (normalized === 'lite' || normalized === 'balanced') return normalized;
  return null;
}

/**
 * Resolve an effort preset to its concrete settings.
 * `balanced` resolves to null (identity — keep current defaults) so it never
 * overrides explicit values; `lite` returns its preset values.
 * @param effort - Parsed effort preset, or null/undefined when unset.
 * @returns Preset settings for `lite`, or null for unset/`balanced`.
 */
export function resolveReviewEffort(
  effort: ReviewEffort | null | undefined,
): ReviewEffortPreset | null {
  if (effort === 'lite') return { ...REVIEW_EFFORT_PRESETS.lite };
  return null;
}
