/**
 * Semantic label colors for severity labels.
 *
 * The GitHub Labels API only accepts a 6-character hex color (no theming
 * support), so a single palette is shipped for both light and dark mode.
 * Palette colors are chosen for at least 4.5:1 contrast against the label's
 * white text (WCAG AA) in light mode; GitHub dark mode renders label text
 * and backgrounds differently (dimmed backgrounds, adapted foregrounds), so
 * the light-mode ratio is a best-effort signal there rather than a guarantee.
 * Re-verify contrast against GitHub's dark-mode label rendering if severity
 * colors change, or expose a dark-mode palette alongside this one.
 */
const SEVERITY_LABEL_COLORS: Record<string, string> = {
  'audit:critical': 'b60205',
  'audit:important': '9a5a00',
  'audit:minor': '0b5c9e',
  'risk:high': 'b60205',
  'risk:medium': '9a5a00',
  'risk:low': '0b7a3e',
  'review-time:<15m': '0b5c9e',
  'review-time:15-60m': '6f42c1',
  'review-time:>60m': '7a2e00',
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
