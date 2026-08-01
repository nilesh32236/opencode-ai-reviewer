import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import {
  buildReviewBody,
  formatConfidenceLabel,
  formatIssueBullet,
  getSeverityBadge,
} from '../src/utils/review-body.js';

describe('review-body', () => {
  describe('getSeverityBadge', () => {
    it('maps each severity to its own aligned badge', () => {
      expect(getSeverityBadge('critical')).toBe('🔴');
      expect(getSeverityBadge('important')).toBe('🟠');
      expect(getSeverityBadge('minor')).toBe('🔵');
    });
  });

  describe('formatConfidenceLabel', () => {
    it('appends explicit text for low and medium confidence', () => {
      expect(formatConfidenceLabel('low')).toBe(' **[low confidence]**');
      expect(formatConfidenceLabel('medium')).toBe(' **[medium confidence]**');
    });

    it('appends nothing for high or undefined confidence', () => {
      expect(formatConfidenceLabel('high')).toBe('');
      expect(formatConfidenceLabel(undefined)).toBe('');
    });
  });

  describe('formatIssueBullet', () => {
    it('renders severity badge that agrees with the severity label', () => {
      const bullet = formatIssueBullet({
        type: 'issue',
        severity: 'critical',
        file: 'src/a.ts',
        line: 42,
        message: 'Missing auth check.',
      });
      expect(bullet).toContain('🔴');
      expect(bullet).toContain('**CRITICAL:**');
      expect(bullet).toContain('`src/a.ts:42`');
      expect(bullet).toContain('Missing auth check.');
    });

    it('appends confidence label for low confidence findings', () => {
      const bullet = formatIssueBullet({
        type: 'issue',
        severity: 'minor',
        file: 'src/b.ts',
        line: 20,
        message: 'Unused import.',
        confidence: 'low',
      });
      expect(bullet).toContain('🔵');
      expect(bullet).toContain('**[low confidence]**');
    });
  });

  describe('buildReviewBody', () => {
    it('builds a complete review body with severity-aligned badges', () => {
      const result: ReviewResult = {
        summary: 'Good PR overall.',
        verdict: { ready: false, reasoning: 'One critical issue found.' },
        strengths: [{ type: 'strength', file: 'src/a.ts', line: 10, message: 'Clean function.' }],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/b.ts',
            line: 42,
            message: 'Missing auth check.',
            suggestion: 'Add requireAuth middleware.',
          },
        ],
        stats: { total: 1, critical: 1, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const body = buildReviewBody(result);

      expect(body).toContain('Good PR overall.');
      expect(body).toContain('**Ready to merge?** false');
      expect(body).toContain('One critical issue found.');
      expect(body).toContain('Clean function.');
      expect(body).toContain('🔴');
      expect(body).toContain('**CRITICAL:**');
      expect(body).toContain('Missing auth check.');
      expect(body).toContain('How to fix:');
    });

    it('renders a critical+high issue with a red badge and no confidence suffix', () => {
      const result: ReviewResult = {
        summary: 'Test.',
        verdict: { ready: false, reasoning: 'Issues found.' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 10,
            message: 'High confidence issue.',
            confidence: 'high',
          },
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/b.ts',
            line: 20,
            message: 'Low confidence issue.',
            confidence: 'low',
          },
        ],
        stats: { total: 2, critical: 1, important: 0, minor: 1 },
        rawLines: [],
        failedLines: 0,
      };

      const body = buildReviewBody(result);

      expect(body).toContain('🔴 **CRITICAL:**');
      expect(body).not.toContain('[high confidence]');
      expect(body).toContain('🔵 **MINOR:**');
      expect(body).toContain('**[low confidence]**');
    });

    it('handles empty result gracefully', () => {
      const emptyResult: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const body = buildReviewBody(emptyResult);
      expect(body).toContain('MR Review Summary');
    });

    it('renders a partial-review banner when failedBatches is set', () => {
      const result: ReviewResult = {
        summary: 'Partial result.',
        verdict: { ready: false, reasoning: 'Some batches failed.' },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
        failedBatches: 2,
      };

      const body = buildReviewBody(result);
      expect(body).toContain('Partial review');
      expect(body).toContain('2 file batch(es) failed');
    });

    it('omits the partial-review banner when no batches failed', () => {
      const result: ReviewResult = {
        summary: 'Full result.',
        verdict: { ready: true, reasoning: 'All good.' },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const body = buildReviewBody(result);
      expect(body).not.toContain('Partial review');
    });
  });
});
