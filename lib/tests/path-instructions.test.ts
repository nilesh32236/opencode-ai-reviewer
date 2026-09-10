import { describe, expect, it, vi } from 'vitest';
import { buildSubagentReviewPrompt } from '../src/agents/prompts.js';
import {
  isValidPathGlob,
  resolveConfig,
  sanitizePathInstructions,
  validateConfig,
} from '../src/config.js';
import {
  buildPathInstructionsSection,
  buildReviewPrompt,
  getMatchedPathInstructions,
} from '../src/prompts/builder.js';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  const setFailed = vi.fn();
  return { warning, info, debug, setFailed };
});

describe('pathInstructions', () => {
  it('match injects a scoped section; no-match leaves prompt unchanged', () => {
    const base = buildReviewPrompt({ projectContext: 'ctx' }, 'PR body');
    const matched = buildReviewPrompt({ projectContext: 'ctx' }, 'PR body', {
      filePaths: ['docs/guide.md'],
      pathInstructions: { 'docs/**': 'Check spelling.' },
    });
    expect(matched).toContain('## Path-Specific Review Instructions');
    expect(matched).toContain('Check spelling.');
    const noMatch = buildReviewPrompt({ projectContext: 'ctx' }, 'PR body', {
      filePaths: ['src/app.ts'],
      pathInstructions: { 'docs/**': 'Check spelling.' },
    });
    expect(noMatch).not.toContain('## Path-Specific Review Instructions');
    expect(noMatch).toBe(base);
  });

  it('truncates to 10 entries and skips oversize/invalid entries', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 12; i++) big[`p${i}/**`] = `rule ${i}`;
    const sanitized = sanitizePathInstructions(big);
    expect(Object.keys(sanitized!).length).toBe(10);

    expect(sanitizePathInstructions({ 'docs/**': 'x'.repeat(3000) })).toBeUndefined();
    // minimatch never throws on '[' — explicit validation must reject it.
    expect(isValidPathGlob('[')).toBe(false);
    expect(isValidPathGlob('docs/**')).toBe(true);
    expect(isValidPathGlob('   ')).toBe(false);
    expect(sanitizePathInstructions({ '[': 'rule' })).toBeUndefined();
    const matched = getMatchedPathInstructions({ '[': 'rule' }, ['src/a.ts']);
    expect(matched).toEqual([]);
  });

  it('rejects arrays instead of consuming the entry budget with numeric keys', () => {
    expect(sanitizePathInstructions(['docs/**'])).toBeUndefined();
    const validated = validateConfig({ review: { pathInstructions: ['x'] as never } });
    expect(validated.review?.pathInstructions).toBeUndefined();
  });

  it('override merge preserves base entries and re-applies caps', () => {
    const baseEntries: Record<string, string> = {};
    for (let i = 0; i < 10; i++) baseEntries[`base${i}/**`] = `base ${i}`;
    const resolved = resolveConfig(
      {
        review: { pathInstructions: baseEntries },
        overrides: [
          {
            path: '**',
            review: {
              pathInstructions: { 'extra/**': 'extra rule', '[': 'bad', 'base0/**': 'override' },
            },
          },
        ],
      },
      { paths: ['extra/a.ts'] },
    );
    const map = resolved.review?.pathInstructions ?? {};
    // Recapped to 10 entries, invalid glob dropped, base entries preserved.
    // First-10-wins: base already holds 10 entries so the override's new
    // 'extra/**' entry is dropped, while 'base0/**' is overridden in place.
    expect(Object.keys(map).length).toBe(10);
    expect(map['[']).toBeUndefined();
    expect(map['extra/**']).toBeUndefined();
    expect(map['base0/**']).toBe('override');
    expect(map['base1/**']).toBe('base 1');
  });

  it('multi-agent orchestrator prompt includes matched path instructions', () => {
    const prompt = buildSubagentReviewPrompt(
      {
        inputs: {},
        prContext: 'PR body',
        filePaths: ['docs/guide.md'],
        pathInstructions: { 'docs/**': 'Check spelling.' },
      },
      ['security'],
    );
    expect(prompt).toContain('## Path-Specific Review Instructions');
    expect(prompt).toContain('Check spelling.');
  });

  it('sanitizes glob labels interpolated into the markdown header', () => {
    const section = buildPathInstructionsSection([{ glob: 'docs/**', instruction: 'rule' }]);
    expect(section).toContain('### Glob `docs/**`');
    // A newline/backtick in a repo-controlled glob must not break header structure.
    const evil = buildPathInstructionsSection([
      { glob: 'docs/**\n`injected`', instruction: 'rule' },
    ]);
    expect(evil).toContain('### Glob `docs/** injected`');
    expect(evil).not.toContain('`injected`');
  });
});
