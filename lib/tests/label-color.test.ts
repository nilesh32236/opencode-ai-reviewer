import { describe, expect, it } from 'vitest';
import { getLabelColor } from '../src/utils/label-color.js';

/** Compute WCAG relative luminance for a 6-char hex color. */
function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of a color against white text (GitHub label text). */
function contrastAgainstWhite(hex: string): number {
  const l = relativeLuminance(hex);
  return (1.0 + 0.05) / (l + 0.05);
}

describe('getLabelColor', () => {
  it('maps severity labels to the semantic palette', () => {
    expect(getLabelColor('audit:critical')).toBe('b60205');
    expect(getLabelColor('audit:important')).toBe('9a5a00');
    expect(getLabelColor('audit:minor')).toBe('0b5c9e');
  });

  it('gives non-severity labels a distinct deterministic color', () => {
    expect(getLabelColor('audit:security')).toBe(getLabelColor('audit:security'));
    expect(getLabelColor('audit:security')).not.toBe(getLabelColor('autofix'));
    expect(getLabelColor('autofix')).not.toBe('6e7781');
  });

  it('falls back to neutral gray only for an empty name', () => {
    expect(getLabelColor('')).toBe('6e7781');
  });

  it('returns the same color for the same name (deterministic)', () => {
    expect(getLabelColor('audit:critical')).toBe(getLabelColor('audit:critical'));
    expect(getLabelColor('audit:security-privacy')).toBe(getLabelColor('audit:security-privacy'));
  });

  it('returns 6-char hex colors without a leading #', () => {
    for (const name of [
      'audit:critical',
      'audit:important',
      'audit:minor',
      'audit:security-privacy',
      'autofix',
      'unknown',
    ]) {
      expect(getLabelColor(name)).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  it('all palette colors meet WCAG AA 4.5:1 contrast against white text', () => {
    for (const name of [
      'audit:critical',
      'audit:important',
      'audit:minor',
      'audit:security-privacy',
      'autofix',
      'analysis:ready',
      'unknown',
    ]) {
      expect(contrastAgainstWhite(getLabelColor(name))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
