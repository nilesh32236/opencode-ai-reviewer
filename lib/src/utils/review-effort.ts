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
 *
 * `lite` and `max` carry concrete overrides. `balanced` is intentionally
 * absent: it resolves to null (identity — keep current defaults) so it never
 * overrides explicit values.
 *
 * `lite` effect vs defaults: it reduces batchSize 3 → 2. Its
 * `maxLinesPerFile: 200` and `enableMetaVerification: false` already match the
 * lib defaults (`DEFAULT_CONFIG`: 200 / false), so against lib defaults only
 * the batch size changes; against the Action input defaults
 * (`max_files_per_batch: 3`, `max_lines_per_file: 500`) it also constrains
 * per-file context 500 → 200.
 *
 * `max` raises depth above the Action defaults: batchSize 3 → 5,
 * maxLinesPerFile 500 → 800, and enables the existing meta-verification pass.
 * It adds no new external calls; cost/latency increase only when opted in.
 */
export const REVIEW_EFFORT_PRESETS: Record<
  Exclude<ReviewEffort, 'balanced'>,
  ReviewEffortPreset
> = {
  lite: { batchSize: 2, maxLinesPerFile: 200, enableMetaVerification: false },
  max: { batchSize: 5, maxLinesPerFile: 800, enableMetaVerification: true },
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
  if (normalized === 'lite' || normalized === 'balanced' || normalized === 'max') return normalized;
  return null;
}

/**
 * Resolve an effort preset to its concrete settings.
 * `balanced` resolves to null (identity — keep current defaults) so it never
 * overrides explicit values; `lite` and `max` return their preset values.
 * @param effort - Parsed effort preset, or null/undefined when unset.
 * @returns Preset settings for `lite`/`max`, or null for unset/`balanced`.
 */
export function resolveReviewEffort(
  effort: ReviewEffort | null | undefined,
): ReviewEffortPreset | null {
  if (effort === 'lite' || effort === 'max') return { ...REVIEW_EFFORT_PRESETS[effort] };
  return null;
}
