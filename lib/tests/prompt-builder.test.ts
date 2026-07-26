import { describe, expect, it } from 'vitest';
import {
  buildAnalyzePrompt,
  buildFixPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
} from '../src/prompts/builder.js';

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
      expect(prompt).toContain('### Blocking Questions');
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

  describe('buildReplyPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildReplyPrompt(
        'src/index.ts',
        42,
        'function foo() { return 1; }',
        'This line has a bug',
        [],
        'Why is this critical?',
      );
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(50);
    });

    it('includes code context and file path', () => {
      const prompt = buildReplyPrompt(
        'src/app.ts',
        10,
        'const x = 1;',
        'Consider renaming this variable',
        [],
        'What would you suggest instead?',
      );
      expect(prompt).toContain('src/app.ts');
      expect(prompt).toContain('line 10');
      expect(prompt).toContain('const x = 1;');
    });

    it('includes original review comment', () => {
      const prompt = buildReplyPrompt(
        'src/index.ts',
        undefined,
        'code',
        'This is a security issue',
        [],
        'Why?',
      );
      expect(prompt).toContain('This is a security issue');
      expect(prompt).toContain('## Original Review Comment');
    });

    it('includes thread history when available', () => {
      const threadHistory = [
        { author: 'opencode-bot', body: 'This line has a bug' },
        { author: 'developer', body: 'Why do you think so?' },
      ];
      const prompt = buildReplyPrompt(
        'src/index.ts',
        5,
        'code snippet',
        'This line has a bug',
        threadHistory,
        'Can you explain more?',
      );
      expect(prompt).toContain('## Thread History');
      expect(prompt).toContain('@opencode-bot');
      // The user's own reply (last entry) is shown in Developer's Question instead
      expect(prompt).not.toContain('@developer');
      expect(prompt).toContain('This line has a bug');
    });

    it('includes developers question', () => {
      const prompt = buildReplyPrompt(
        'src/index.ts',
        undefined,
        'code',
        'Nit: use a constant',
        [],
        'Where should I define it?',
      );
      expect(prompt).toContain("Developer's Question");
      expect(prompt).toContain('Where should I define it?');
    });

    it('includes instructions section', () => {
      const prompt = buildReplyPrompt('src/index.ts', undefined, 'code', 'comment', [], 'question');
      expect(prompt).toContain('## Instructions');
      expect(prompt).toContain('Answer concisely');
      expect(prompt).toContain('acknowledge it gracefully');
    });
  });
});
