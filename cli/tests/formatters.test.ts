import type { ReviewResult } from '@opencode-pr-agent/lib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-pr-agent/lib', () => ({
  formatIssueBullet: (issue: {
    severity: string;
    file: string;
    line: number;
    message: string;
    confidence?: 'high' | 'medium' | 'low';
  }) =>
    `- **${issue.severity.toUpperCase()}:** \`${issue.file}:${issue.line}\` — ${issue.message}${issue.confidence ? ` **[${issue.confidence} confidence]**` : ''}`,
  buildTokenUsageSection: (usage: { totalTokens?: number } | undefined) =>
    usage?.totalTokens ? `### Token Usage\n\n| Total Tokens | ${usage.totalTokens} |` : '',
  getSeverityBadge: (severity: string) =>
    severity === 'critical' ? '🔴' : severity === 'important' ? '🟠' : '🔵',
}));

import { formatJson } from '../src/formatters/json.js';
import { formatMarkdown } from '../src/formatters/markdown.js';
import { formatTerminal } from '../src/formatters/terminal.js';

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: '',
    verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    ...overrides,
  };
}

describe('formatJson', () => {
  it('serializes a result to valid JSON', () => {
    const json = formatJson(makeResult({ summary: 'ok' }));
    const parsed = JSON.parse(json) as { summary: string; verdict: { ready: boolean } };
    expect(parsed.summary).toBe('ok');
    expect(parsed.verdict.ready).toBe(false);
  });
});

describe('formatMarkdown', () => {
  it('renders an empty result with a verdict', () => {
    const md = formatMarkdown(makeResult());
    expect(md).toContain('# OpenCode AI Reviewer — Local Review');
    expect(md).toContain('**Verdict:** ❌ **NOT READY**');
  });

  it('renders the partial-review banner when batches failed', () => {
    const md = formatMarkdown(makeResult({ failedBatches: 2 }));
    expect(md).toContain('**Partial review** — 2 file batch(es) failed');
  });

  it('wraps suggestionCode in a details + suggestion fence', () => {
    const md = formatMarkdown(
      makeResult({
        issues: [
          {
            severity: 'minor' as const,
            file: 'src/a.ts',
            line: 3,
            message: 'msg',
            suggestionCode: 'console.log(1);',
          },
        ],
      }),
    );
    expect(md).toContain('<details><summary>Show suggested fix</summary>');
    expect(md).toContain('```suggestion');
    expect(md).toContain('console.log(1);');
  });

  it('uses a longer fence when suggestionCode contains triple backticks', () => {
    const md = formatMarkdown(
      makeResult({
        issues: [
          {
            severity: 'minor' as const,
            file: 'src/a.ts',
            line: 3,
            message: 'msg',
            suggestionCode: '```\nconst x = 1;\n```',
          },
        ],
      }),
    );
    expect(md).toContain('````suggestion');
    expect(md).not.toContain('\n```suggestion\n```\n');
  });

  it('renders the executive summary section when present', () => {
    const md = formatMarkdown(
      makeResult({
        executiveSummary: {
          purpose: 'Add local CLI reviews',
          riskLevel: 'medium',
          riskRationale: 'Medium risk',
          breakingChanges: ['CLI requires node >= 20'],
        },
      }),
    );
    expect(md).toContain('## Executive Summary');
    expect(md).toContain('**Purpose:** Add local CLI reviews');
    expect(md).toContain('**Risk:** 🟡 MEDIUM — Medium risk');
    expect(md).toContain('- ⚠️ CLI requires node >= 20');
  });
});

describe('formatTerminal', () => {
  it('renders an empty result with a verdict', () => {
    const out = formatTerminal(makeResult());
    expect(out).toContain('Verdict:');
    expect(out).toContain('NOT READY');
  });

  it('renders issues with their severity', () => {
    const out = formatTerminal(
      makeResult({
        issues: [
          {
            severity: 'critical' as const,
            file: 'src/a.ts',
            line: 1,
            message: 'danger',
          },
        ],
      }),
    );
    expect(out).toContain('CRITICAL');
    expect(out).toContain('src/a.ts:1');
  });

  it('renders the executive summary when present', () => {
    const out = formatTerminal(
      makeResult({
        executiveSummary: {
          purpose: 'Add local CLI reviews',
          riskLevel: 'high',
          riskRationale: 'High risk',
          breakingChanges: [],
        },
      }),
    );
    expect(out).toContain('Executive Summary');
    expect(out).toContain('HIGH');
  });
});
