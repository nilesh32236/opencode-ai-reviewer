import { describe, expect, it } from 'vitest';
import { buildAnalyzePrompt, buildFixPrompt, buildReviewPrompt } from '../src/prompts/builder.js';

describe('prompt-builder', () => {
  it('buildReviewPrompt returns a non-empty string', () => {
    const prompt = buildReviewPrompt(
      { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
      'PR #1 test',
    );
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(50);
  });

  it('buildReviewPrompt includes the PR context', () => {
    const prContext = 'Test PR context with specific details';
    const prompt = buildReviewPrompt(
      { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
      prContext,
    );
    expect(prompt).toContain(prContext);
  });

  it('buildReviewPrompt appends reviewPromptExtra when set', () => {
    const extra = 'EXTRA_INSTRUCTIONS';
    const prompt = buildReviewPrompt(
      { reviewPromptFile: '', reviewPromptExtra: extra, maxFilesPerBatch: 3, projectContext: '' },
      'PR #1',
    );
    expect(prompt).toContain(extra);
  });

  it('injects learning lessons when provided', () => {
    const prompt = buildReviewPrompt({ maxFilesPerBatch: 3 }, '## PR Context\n...', [
      'Always handle async errors',
      'Use strict equality checks',
    ]);
    expect(prompt).toContain('## Historical Lessons');
    expect(prompt).toContain('Always handle async errors');
  });

  it('buildFixPrompt returns a non-empty string', () => {
    const prompt = buildFixPrompt(
      { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
      'PR context with issues',
      1,
    );
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe('string');
  });

  it('buildFixPrompt includes the iteration number', () => {
    const prompt = buildFixPrompt(
      { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
      'Some context',
      2,
    );
    expect(prompt).toContain('2');
  });

  describe('buildAnalyzePrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildAnalyzePrompt({ projectContext: '' }, 'Issue description');
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(50);
    });

    it('includes the issue context', () => {
      const issueContext = 'Test issue context with specific details';
      const prompt = buildAnalyzePrompt({ projectContext: '' }, issueContext);
      expect(prompt).toContain(issueContext);
    });

    it('includes output structure instructions', () => {
      const prompt = buildAnalyzePrompt({ projectContext: '' }, 'Issue description');
      expect(prompt).toContain('.opencode/analysis-plan.md');
      expect(prompt).toContain('## 📊 Summary & Priority');
      expect(prompt).toContain('## 📁 Affected Files');
      expect(prompt).toContain('## 🛠️ Step-by-Step Implementation Plan');
      expect(prompt).toContain('## ❓ Questions / Decisions Needed from Maintainer');
    });

    it('uses provided project context', () => {
      const prompt = buildAnalyzePrompt({ projectContext: 'Custom project context' }, 'Issue');
      expect(prompt).toContain('Custom project context');
    });

    it('uses projectContextStr override when provided', () => {
      const prompt = buildAnalyzePrompt(
        { projectContext: 'Default context' },
        'Issue',
        'Override context',
      );
      expect(prompt).toContain('Override context');
      expect(prompt).not.toContain('Default context');
    });

    it('includes critical rules about read-only analysis', () => {
      const prompt = buildAnalyzePrompt({ projectContext: '' }, 'Issue');
      expect(prompt).toContain('Do NOT run');
      expect(prompt).toContain('git commit');
      expect(prompt).toContain('read-only analysis');
    });
  });
});
