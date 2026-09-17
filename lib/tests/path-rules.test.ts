import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PATH_RULES,
  MAX_PATH_RULE_ENTRIES,
  sanitizePathRules,
  validateConfig,
} from '../src/config.js';
import {
  buildPathRulesSection,
  collectPathRuleOutcomes,
  matchPathRules,
} from '../src/review/path-rules.js';
import { PathRuleSchema, PromptConfigSchema, ReviewConfigSchema } from '../src/types/schemas.js';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  const setFailed = vi.fn();
  return { warning, info, debug, setFailed };
});

describe('pathRules', () => {
  describe('PathRuleSchema', () => {
    it('parses a camelCase rule', () => {
      const parsed = PathRuleSchema.safeParse({
        paths: ['docs/**'],
        suggestReviewers: ['alice'],
        addLabels: ['docs'],
      });
      expect(parsed.success).toBe(true);
    });

    it('parses a legacy snake_case rule', () => {
      const parsed = PathRuleSchema.safeParse({
        paths: ['docs/**'],
        suggest_reviewers: ['alice'],
        add_labels: ['docs'],
      });
      expect(parsed.success).toBe(true);
    });

    it('parses a skip-only rule', () => {
      const parsed = PathRuleSchema.safeParse({ paths: ['generated/**'], skip: true });
      expect(parsed.success).toBe(true);
    });

    it('rejects a no-op rule with no effective action', () => {
      const parsed = PathRuleSchema.safeParse({ paths: ['docs/**'] });
      expect(parsed.success).toBe(false);
    });

    it('rejects empty-string globs', () => {
      const parsed = PathRuleSchema.safeParse({ paths: [''], skip: true });
      expect(parsed.success).toBe(false);
    });

    it('rejects whitespace-only and overlong reviewer entries', () => {
      expect(
        PathRuleSchema.safeParse({ paths: ['docs/**'], suggestReviewers: ['   '] }).success,
      ).toBe(false);
      expect(
        PathRuleSchema.safeParse({ paths: ['docs/**'], suggestReviewers: ['x'.repeat(257)] })
          .success,
      ).toBe(false);
    });

    it('rejects reviewer/label lists beyond the per-list cap', () => {
      const reviewers = Array.from({ length: 21 }, (_, i) => `user-${i}`);
      expect(
        PathRuleSchema.safeParse({ paths: ['docs/**'], suggestReviewers: reviewers }).success,
      ).toBe(false);
    });
  });

  describe('review schema wiring (fail-open)', () => {
    it('keeps valid rules while dropping no-op peers without failing the parse', () => {
      const parsed = PromptConfigSchema.safeParse({
        review: {
          systemPrompt: 'stay',
          pathRules: [{ paths: ['docs/**'], suggestReviewers: ['alice'] }, { paths: ['nope/**'] }],
        },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.review?.systemPrompt).toBe('stay');
        expect(parsed.data.review?.pathRules).toHaveLength(1);
      }
    });

    it('truncates oversized pathRules arrays instead of failing the parse', () => {
      const rules = Array.from({ length: 25 }, (_, i) => ({
        paths: [`area-${i}/**`],
        skip: true,
      }));
      const parsed = ReviewConfigSchema.safeParse({ pathRules: rules });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.pathRules).toHaveLength(MAX_PATH_RULES);
      }
    });

    it('degrades non-array pathRules to undefined without failing the parse', () => {
      const parsed = PromptConfigSchema.safeParse({
        review: { pathRules: 'not-an-array', inline: true },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.review?.pathRules).toBeUndefined();
        expect(parsed.data.review?.inline).toBe(true);
      }
    });
  });

  describe('sanitizePathRules', () => {
    it('normalizes camelCase input', () => {
      const out = sanitizePathRules([
        { paths: ['docs/**'], suggestReviewers: [' alice '], addLabels: [' docs '] },
      ]);
      expect(out).toEqual([
        { paths: ['docs/**'], suggestReviewers: ['alice'], addLabels: ['docs'] },
      ]);
    });

    it('normalizes legacy snake_case input to camelCase', () => {
      const out = sanitizePathRules([
        { paths: ['docs/**'], suggest_reviewers: ['alice'], add_labels: ['docs'] },
      ]);
      expect(out).toEqual([
        { paths: ['docs/**'], suggestReviewers: ['alice'], addLabels: ['docs'] },
      ]);
    });

    it('prefers camelCase when both spellings are present', () => {
      const out = sanitizePathRules([
        {
          paths: ['docs/**'],
          suggestReviewers: ['alice'],
          suggest_reviewers: ['bob'],
        },
      ]);
      expect(out?.[0]?.suggestReviewers).toEqual(['alice']);
    });

    it('truncates rule and entry counts and dedups values', () => {
      const rules = Array.from({ length: MAX_PATH_RULES + 5 }, (_, i) => ({
        paths: [`area-${i}/**`],
        suggestReviewers: ['alice', 'alice', '  ', 'bob'],
      }));
      const out = sanitizePathRules(rules);
      expect(out).toHaveLength(MAX_PATH_RULES);
      expect(out?.[0]?.suggestReviewers).toEqual(['alice', 'bob']);

      const many = Array.from({ length: MAX_PATH_RULE_ENTRIES + 5 }, (_, i) => `user-${i}`);
      const capped = sanitizePathRules([{ paths: ['docs/**'], suggestReviewers: many }]);
      expect(capped?.[0]?.suggestReviewers).toHaveLength(MAX_PATH_RULE_ENTRIES);
    });

    it('drops invalid globs and no-op rules, returning undefined when empty', () => {
      expect(sanitizePathRules([{ paths: ['['], suggestReviewers: ['alice'] }])).toBeUndefined();
      expect(sanitizePathRules([{ paths: ['docs/**'] }])).toBeUndefined();
      expect(sanitizePathRules('nope')).toBeUndefined();
      expect(sanitizePathRules(undefined)).toBeUndefined();
      expect(sanitizePathRules([])).toBeUndefined();
    });
  });

  describe('validateConfig round-trip', () => {
    it('preserves camelCase rules and normalizes snake_case aliases', () => {
      const camel = validateConfig({
        review: { pathRules: [{ paths: ['docs/**'], suggestReviewers: ['alice'] }] },
      });
      expect(camel.review?.pathRules).toEqual([
        { paths: ['docs/**'], suggestReviewers: ['alice'] },
      ]);

      const snake = validateConfig({
        review: {
          pathRules: [{ paths: ['docs/**'], suggest_reviewers: ['alice'], add_labels: ['docs'] }],
        },
      });
      expect(snake.review?.pathRules).toEqual([
        { paths: ['docs/**'], suggestReviewers: ['alice'], addLabels: ['docs'] },
      ]);
    });
  });

  describe('matching outcomes', () => {
    it('aggregates camelCase reviewers, labels, and skips', () => {
      const rules = sanitizePathRules([
        { paths: ['docs/**'], suggestReviewers: ['alice'], addLabels: ['docs'] },
        { paths: ['generated/**'], skip: true },
      ])!;
      expect(matchPathRules('docs/guide.md', rules)).toHaveLength(1);
      const outcomes = collectPathRuleOutcomes(
        ['docs/guide.md', 'generated/out.js', 'src/app.ts'],
        rules,
      );
      expect(outcomes.suggestedReviewers).toEqual(['alice']);
      expect(outcomes.labelsToApply).toEqual(['docs']);
      expect(outcomes.skippedFiles).toEqual(['generated/out.js']);
      expect(outcomes.keptFiles).toEqual(['docs/guide.md', 'src/app.ts']);
      expect(buildPathRulesSection(outcomes)).toContain('Path-based Review Routing');
    });

    it('reads legacy snake_case rules that bypassed normalization', () => {
      const outcomes = collectPathRuleOutcomes(
        ['docs/guide.md'],
        [{ paths: ['docs/**'], suggest_reviewers: ['bob'], add_labels: ['docs'] }],
      );
      expect(outcomes.suggestedReviewers).toEqual(['bob']);
      expect(outcomes.labelsToApply).toEqual(['docs']);
    });
  });
});
