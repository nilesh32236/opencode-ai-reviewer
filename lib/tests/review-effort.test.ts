import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  const setFailed = vi.fn();
  return { warning, info, debug, setFailed };
});

import * as core from '@actions/core';
import { validateConfig } from '../src/config.js';
import { PromptConfigSchema, ReviewConfigSchema } from '../src/types/schemas.js';
import {
  REVIEW_EFFORT_PRESETS,
  parseReviewEffort,
  resolveReviewEffort,
} from '../src/utils/review-effort.js';

describe('parseReviewEffort', () => {
  it('normalizes case and whitespace', () => {
    expect(parseReviewEffort('lite')).toBe('lite');
    expect(parseReviewEffort(' Lite ')).toBe('lite');
    expect(parseReviewEffort('BALANCED')).toBe('balanced');
    expect(parseReviewEffort('  balanced  ')).toBe('balanced');
  });

  it('returns null for unset/invalid/non-string values', () => {
    expect(parseReviewEffort(undefined)).toBeNull();
    expect(parseReviewEffort(null)).toBeNull();
    expect(parseReviewEffort('')).toBeNull();
    expect(parseReviewEffort('turbo')).toBeNull();
    expect(parseReviewEffort('Lite!')).toBeNull();
    expect(parseReviewEffort(42)).toBeNull();
    expect(parseReviewEffort({})).toBeNull();
  });
});

describe('resolveReviewEffort', () => {
  it('returns a copy of the lite preset', () => {
    const resolved = resolveReviewEffort('lite');
    expect(resolved).toEqual({ batchSize: 2, maxLinesPerFile: 200, enableMetaVerification: false });
    expect(resolved).not.toBe(REVIEW_EFFORT_PRESETS.lite);
  });

  it('returns null for balanced/unset (identity)', () => {
    expect(resolveReviewEffort('balanced')).toBeNull();
    expect(resolveReviewEffort(null)).toBeNull();
    expect(resolveReviewEffort(undefined)).toBeNull();
  });

  it('exposes only the lite preset (no misleading balanced entry)', () => {
    expect(Object.keys(REVIEW_EFFORT_PRESETS)).toEqual(['lite']);
  });
});

describe('effort schema fail-open', () => {
  it('ReviewConfigSchema normalizes case and drops invalid effort instead of throwing', () => {
    expect(ReviewConfigSchema.parse({ effort: ' Lite ' }).effort).toBe('lite');
    expect(ReviewConfigSchema.parse({ effort: 'BALANCED' }).effort).toBe('balanced');
    expect(ReviewConfigSchema.parse({ effort: 'turbo' }).effort).toBeUndefined();
    expect(ReviewConfigSchema.parse({}).effort).toBeUndefined();
  });

  it('PromptConfigSchema drops only the effort field on invalid values', () => {
    const parsed = PromptConfigSchema.parse({
      review: { systemPrompt: 'Be thorough', effort: 'turbo' },
    });
    expect(parsed.review?.effort).toBeUndefined();
    expect(parsed.review?.systemPrompt).toBe('Be thorough');
  });

  it('PromptConfigSchema normalizes case for effort', () => {
    const parsed = PromptConfigSchema.parse({ review: { effort: ' Lite ' } });
    expect(parsed.review?.effort).toBe('lite');
  });
});

describe('validateConfig effort', () => {
  it('accepts lite/balanced (case-insensitive)', () => {
    expect(validateConfig({ review: { effort: 'lite' } }).review?.effort).toBe('lite');
    expect(
      validateConfig({ review: { effort: ' Lite ' as unknown as 'lite' } }).review?.effort,
    ).toBe('lite');
    expect(validateConfig({ review: { effort: 'balanced' } }).review?.effort).toBe('balanced');
  });

  it('warns and drops invalid effort while keeping sibling fields', () => {
    const warning = vi.mocked(core.warning);
    warning.mockClear();
    const result = validateConfig({
      review: { systemPrompt: 'hi', effort: 'turbo' as unknown as 'lite' },
    });
    expect(result.review?.effort).toBeUndefined();
    expect(result.review?.systemPrompt).toBe('hi');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('review.effort'));
  });
});
