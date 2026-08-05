import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROMPT_BUILDERS,
  buildLogicPrompt,
  buildPerformancePrompt,
  buildQualityPrompt,
  buildSecurityPrompt,
} from '../src/agents/index.js';
import type { AgentPromptContext } from '../src/agents/types.js';
import { parseAgentJsonlString } from '../src/jsonl-parser.js';
import type { AgentCategory } from '../src/types/index.js';

function makeAgentContext(overrides: Partial<AgentPromptContext> = {}): AgentPromptContext {
  return {
    inputs: {
      projectContext: 'Project root: /src, framework: vitest',
    },
    prContext: '# PR: Fix flaky tests\n\n- src/util.ts (+10/-2)',
    ...overrides,
  };
}

const CATEGORIES: AgentCategory[] = ['security', 'performance', 'quality', 'logic'];

describe('specialized agent prompt builders', () => {
  it('exposes a builder for every agent category', () => {
    expect(Object.keys(AGENT_PROMPT_BUILDERS).sort()).toEqual([...CATEGORIES].sort());
    for (const category of CATEGORIES) {
      expect(typeof AGENT_PROMPT_BUILDERS[category]).toBe('function');
    }
  });

  it.each(CATEGORIES)('%s agent prompt includes the role, focus, and output format', (category) => {
    const prompt = AGENT_PROMPT_BUILDERS[category](makeAgentContext());
    expect(prompt).toContain(`You are the ${capitalize(category)} Review Agent`);
    expect(prompt).toContain('## PR & Issue Context');
    expect(prompt).toContain('## Project Context');
    expect(prompt).toContain(`## ${promptFocusHeading(category)}`);
    expect(prompt).toContain('## Output Format: JSON Lines');
    expect(prompt).toContain(`"agent":"${category}"`);
    expect(prompt).toContain('AND a `category` field equal to `"' + category + '"`');
    expect(prompt).toContain('## Calibration');
  });

  it('includes the review-level promptExtra as additional instructions', () => {
    const prompt = buildSecurityPrompt(
      makeAgentContext({ inputs: { reviewPromptExtra: 'Focus on auth flows only.' } }),
    );
    expect(prompt).toContain('## Additional Instructions');
    expect(prompt).toContain('Focus on auth flows only.');
  });

  it('prepends a loaded custom prompt file before the focus sections', () => {
    const customFile = path.join(process.cwd(), `.tmp-agent-prompt-${Date.now()}.md`);
    fs.writeFileSync(customFile, 'CUSTOM_AGENT_PROMPT_CONTENT');
    try {
      const prompt = buildSecurityPrompt(
        makeAgentContext({
          inputs: {
            reviewPromptFile: path.basename(customFile),
            reviewPromptExtra: 'Extra agent instructions.',
          },
        }),
      );
      expect(prompt.startsWith('CUSTOM_AGENT_PROMPT_CONTENT')).toBe(true);
      expect(prompt).toContain('You are the Security Review Agent');
      expect(prompt).toContain('Extra agent instructions.');
    } finally {
      fs.unlinkSync(customFile);
    }
  });

  it('omits the project context section when inputs.projectContext is absent', () => {
    const prompt = buildQualityPrompt(makeAgentContext({ inputs: {} }));
    expect(prompt).not.toContain('## Project Context');
  });

  it('caps oversized PR context to the 50k character limit', () => {
    const huge = 'x'.repeat(60_000);
    const prompt = buildLogicPrompt(makeAgentContext({ prContext: huge }));
    const xCount = (prompt.match(/x/g) || []).length;
    expect(xCount).toBeLessThanOrEqual(50_100);
  });

  it('injects the budget banner when budgetMode is summary/split', () => {
    const summary = buildSecurityPrompt(
      makeAgentContext({ budgetMode: 'summary', totalDiffLines: 700 }),
    );
    expect(summary).toContain('## Review Budget Mode: SUMMARY');
    const split = buildPerformancePrompt(
      makeAgentContext({ budgetMode: 'split', totalDiffLines: 1500 }),
    );
    expect(split).toContain('## Review Budget Mode: SPLIT RECOMMENDED');
    const full = buildQualityPrompt(makeAgentContext({ budgetMode: 'full' }));
    expect(full).not.toContain('## Review Budget Mode');
  });

  it('caps the assembled agent prompt at the 200KB prompt-length limit', () => {
    // Only prContext is pre-capped at 50k chars; unbounded inputs like a large
    // projectContext must still be cut by the whole-prompt 200KB cap.
    const huge = 'y'.repeat(300_000);
    const prompt = buildLogicPrompt(makeAgentContext({ inputs: { projectContext: huge } }));
    expect(prompt.length).toBeLessThan(204_800 + 200);
    expect(prompt).toContain('... [prompt truncated at 200KB cap]');
  });

  it('exported builders share the same generic prompt structure', () => {
    const security = buildSecurityPrompt(makeAgentContext());
    const performance = buildPerformancePrompt(makeAgentContext());
    const quality = buildQualityPrompt(makeAgentContext());
    const logic = buildLogicPrompt(makeAgentContext());
    for (const prompt of [security, performance, quality, logic]) {
      expect(prompt).toContain('## PR & Issue Context');
      expect(prompt).toContain('## Output Format: JSON Lines');
      expect(prompt).toContain('## Calibration');
    }
  });
});

describe('parseAgentJsonlString', () => {
  it('attributes issues to the originating agent when the model omits the field', () => {
    const content = [
      JSON.stringify({ type: 'summary', text: 'review' }),
      JSON.stringify({
        type: 'issue',
        severity: 'critical',
        file: 'src/util.ts',
        line: 42,
        message: 'SQL injection',
      }),
    ].join('\n');
    const result = parseAgentJsonlString(content, 'security');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].agent).toBe('security');
    expect(result.agent).toBe('security');
  });

  it('preserves an explicit inline agent field from the model output', () => {
    // The shared parser now retains the per-issue `agent` field, so a model that
    // correctly labels which category it is reporting keeps that attribution
    // instead of always falling back to the invoked run category.
    const content = JSON.stringify({
      type: 'issue',
      severity: 'important',
      file: 'src/util.ts',
      line: 10,
      message: 'N+1 query',
      agent: 'performance',
    });
    const result = parseAgentJsonlString(content, 'security');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].agent).toBe('performance');
  });

  it('coerces numeric confidence values into the canonical string union', () => {
    const content = [
      JSON.stringify({
        type: 'issue',
        severity: 'minor',
        file: 'src/a.ts',
        line: 1,
        message: 'duplicate',
        confidence: 0.9,
      }),
      JSON.stringify({
        type: 'issue',
        severity: 'minor',
        file: 'src/b.ts',
        line: 2,
        message: 'duplicate',
        confidence: 0.6,
      }),
      JSON.stringify({
        type: 'issue',
        severity: 'minor',
        file: 'src/c.ts',
        line: 3,
        message: 'duplicate',
        confidence: 0.1,
      }),
    ].join('\n');
    const result = parseAgentJsonlString(content, 'security');
    expect(result.findings.map((f) => f.confidence)).toEqual(['high', 'medium', 'low']);
  });
});

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function promptFocusHeading(category: AgentCategory): string {
  switch (category) {
    case 'security':
      return 'Security Focus (OWASP Top 10 & Secrets)';
    case 'performance':
      return 'Performance Focus';
    case 'quality':
      return 'Code Quality Focus';
    case 'logic':
      return 'Logic Focus';
  }
}
