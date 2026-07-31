/** Semantic label colors chosen for at least 4.5:1 contrast against white text. */
const SEVERITY_LABEL_COLORS: Record<string, string> = {
  'audit:critical': 'b60205',
  'audit:important': '9a5a00',
  'audit:minor': '0b5c9e',
};

const DEFAULT_LABEL_COLOR = '6e7781';

/**
 * Get a deterministic label color for a label name.
 *
 * Severity labels map to a small semantic palette (critical=red, important=amber,
 * minor=blue) so severity is visually distinguishable, and all palette colors are
 * chosen for at least 4.5:1 contrast against the label's white text (WCAG AA).
 * Any other label falls back to a neutral gray. The same name always yields the
 * same color, and the value is a 6-character hex without a leading '#'.
 *
 * @param labelName - The label name.
 * @returns A 6-character hex color string (no leading '#').
 */
export function getLabelColor(labelName: string): string {
  return SEVERITY_LABEL_COLORS[labelName] ?? DEFAULT_LABEL_COLOR;
}
