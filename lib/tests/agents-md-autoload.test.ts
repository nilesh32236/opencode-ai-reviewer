import { describe, expect, it, vi } from 'vitest';
import { AGENTS_MD_MAX_BYTES, ReviewEngine } from '../src/engine.js';
import type { AgentConfig, PRContext } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { ProjectContextConfigSchema } from '../src/types/schemas.js';

function makePR(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 42,
    title: 'Test PR',
    body: '',
    headRef: 'feature',
    headSha: 'abc1234567890',
    baseRef: 'main',
    author: 'tester',
    labels: [],
    changedFiles: [],
    ...overrides,
  };
}

function makeConfig(projectContext: Partial<AgentConfig['projectContext']> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    projectContext: {
      ...DEFAULT_CONFIG.projectContext,
      ...projectContext,
    },
  };
}

function makeEngine(
  config: AgentConfig,
  files: Record<string, string | null> | Error,
): { engine: ReviewEngine; getFileContent: ReturnType<typeof vi.fn> } {
  const getFileContent = vi.fn(async (_pr: number, path: string, _ref?: string) => {
    if (files instanceof Error) throw files;
    const content = files[path];
    return content ?? null;
  });
  const engine = new ReviewEngine(config, { getFileContent } as never);
  return { engine, getFileContent };
}

async function loadVia(engine: ReviewEngine, pr: PRContext) {
  return (
    engine as unknown as { loadAgentsMdAtHeadSha: (p: PRContext) => Promise<unknown> }
  ).loadAgentsMdAtHeadSha(pr) as Promise<{ context?: string; footer?: string }>;
}

describe('agents-md head-SHA auto-load', () => {
  it('defaults autoLoadAgentsMd to false in the schema', () => {
    const parsed = ProjectContextConfigSchema.parse({
      description: '',
      typecheckCommands: [],
      lintCommands: [],
    });
    expect(parsed.autoLoadAgentsMd).toBe(false);
    expect(parsed.attributionFooter).toBeUndefined();
  });

  it('loads nothing and makes no API calls when disabled (default)', async () => {
    const { engine, getFileContent } = makeEngine(makeConfig(), {
      'AGENTS.md': 'rules',
    });
    const result = await loadVia(engine, makePR());
    expect(result).toEqual({});
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it('includes both files with header and footer when enabled', async () => {
    const { engine, getFileContent } = makeEngine(makeConfig({ autoLoadAgentsMd: true }), {
      'AGENTS.md': 'Follow TDD.',
      '.github/copilot-instructions.md': 'Use tabs.',
    });
    const result = await loadVia(engine, makePR());
    expect(getFileContent).toHaveBeenCalledTimes(2);
    expect(getFileContent).toHaveBeenCalledWith(42, 'AGENTS.md', 'abc1234567890');
    expect(getFileContent).toHaveBeenCalledWith(
      42,
      '.github/copilot-instructions.md',
      'abc1234567890',
    );
    expect(result.context).toContain('### AGENTS.md @ abc1234');
    expect(result.context).toContain('Follow TDD.');
    expect(result.context).toContain('### .github/copilot-instructions.md @ abc1234');
    expect(result.context).toContain('Use tabs.');
    expect(result.footer).toContain('`AGENTS.md`');
    expect(result.footer).toContain('`abc1234`');
  });

  it('returns empty when both files are absent', async () => {
    const { engine } = makeEngine(makeConfig({ autoLoadAgentsMd: true }), {
      'AGENTS.md': null,
      '.github/copilot-instructions.md': null,
    });
    expect(await loadVia(engine, makePR())).toEqual({});
  });

  it('fails open when the contents API throws', async () => {
    const { engine } = makeEngine(makeConfig({ autoLoadAgentsMd: true }), new Error('API offline'));
    expect(await loadVia(engine, makePR())).toEqual({});
  });

  it('keeps prompt context but omits the footer when attributionFooter is false', async () => {
    const { engine } = makeEngine(
      makeConfig({ autoLoadAgentsMd: true, attributionFooter: false }),
      { 'AGENTS.md': 'Follow TDD.' },
    );
    const result = await loadVia(engine, makePR());
    expect(result.context).toContain('Follow TDD.');
    expect(result.footer).toBeUndefined();
  });

  it('caps each file at ~8KB', async () => {
    const big = 'x'.repeat(AGENTS_MD_MAX_BYTES * 3);
    const { engine } = makeEngine(makeConfig({ autoLoadAgentsMd: true }), {
      'AGENTS.md': big,
    });
    const result = await loadVia(engine, makePR());
    expect(result.context).toBeDefined();
    expect(Buffer.byteLength(result.context as string, 'utf8')).toBeLessThan(
      AGENTS_MD_MAX_BYTES * 2,
    );
    expect(result.footer).toContain('`AGENTS.md`');
  });

  it('skips empty files but loads the other one', async () => {
    const { engine } = makeEngine(makeConfig({ autoLoadAgentsMd: true }), {
      'AGENTS.md': '   ',
      '.github/copilot-instructions.md': 'Use tabs.',
    });
    const result = await loadVia(engine, makePR());
    expect(result.context).toContain('Use tabs.');
    expect(result.context).not.toContain('### AGENTS.md @');
    expect(result.footer).toContain('`.github/copilot-instructions.md`');
    expect(result.footer).not.toContain('AGENTS.md`');
  });
});
