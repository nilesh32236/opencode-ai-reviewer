/** Semantic label colors chosen for at least 4.5:1 contrast against white text. */
const SEVERITY_LABEL_COLORS: Record<string, string> = {
  'audit:critical': 'b60205',
  'audit:important': '9a5a00',
  'audit:minor': '0b5c9e',
};

/**
 * Pre-verified accessible colors (each meets WCAG AA ≥ 4.5:1 contrast against
 * white label text) used to give non-severity labels a distinct, deterministic
 * hue while keeping label-heavy repos scannable.
 */
const HASH_PALETTE = [
  '0a3069', // dark navy
  '953800', // burnt orange
  '116329', // dark green
  '8250df', // violet
  'bf3989', // magenta
  '1f6feb', // blue
  'b01246', // crimson
  '705217', // olive
];

const DEFAULT_LABEL_COLOR = '6e7781';

/**
 * Get a deterministic label color for a label name.
 *
 * Severity labels map to a small semantic palette (critical=red, important=amber,
 * minor=blue) so severity is visually distinguishable, and all palette colors are
 * chosen for at least 4.5:1 contrast against the label's white text (WCAG AA).
 * Any other label is hashed onto a pre-verified palette of accessible colors so
 * each label keeps its own distinct hue, with a neutral gray as the final
 * fallback. The same name always yields the same color, and the value is a
 * 6-character hex without a leading '#'.
 *
 * @param labelName - The label name.
 * @returns A 6-character hex color string (no leading '#').
 */
export function getLabelColor(labelName: string): string {
  const severityColor = SEVERITY_LABEL_COLORS[labelName];
  if (severityColor) return severityColor;
  if (!labelName) return DEFAULT_LABEL_COLOR;
  return HASH_PALETTE[hashString(labelName) % HASH_PALETTE.length] ?? DEFAULT_LABEL_COLOR;
}

/**
 * Compute a deterministic 32-bit hash (FNV-1a) for a label name.
 * @param value - The string to hash.
 * @returns An unsigned 32-bit integer hash.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
