import { describe, expect, it } from 'vitest';
import { buildFixPrompt, buildReviewPrompt } from '../src/prompts/builder.js';

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
});
