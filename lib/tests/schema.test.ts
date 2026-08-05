import { parseJsonlString } from '../src/jsonl-parser.js';
import {
  AgentConfigSchema,
  MultiAgentConfigSchema,
  ReviewBudgetConfigSchema,
  ReviewEntrySchema,
} from '../src/types/schemas.js';

describe('ReviewEntrySchema', () => {
  it('rejects entries with missing required fields', () => {
    const entries = [
      '{"type":"summary"}',
      '{"type":"verdict","ready":true}',
      '{"type":"strength"}',
      '{"type":"issue","severity":"minor"}',
    ];

    for (const entry of entries) {
      expect(ReviewEntrySchema.safeParse(JSON.parse(entry)).success).toBe(false);
    }
  });

  it('rejects entries with invalid required field values', () => {
    const entries = [
      '{"type":"summary","text":"short"}',
      '{"type":"issue","severity":"minor","file":"a.ts","line":0,"message":"nope"}',
    ];

    for (const entry of entries) {
      expect(ReviewEntrySchema.safeParse(JSON.parse(entry)).success).toBe(false);
    }
  });
});

describe('parseJsonlString smoke test', () => {
  it('parses a simple verdict entry', () => {
    const result = parseJsonlString(
      '{"type":"verdict","ready":true,"reasoning":"No issues found."}',
    );
    expect(result.failedLines).toBe(0);
    expect(result.verdict.ready).toBe(true);
  });
});

describe('ReviewBudgetConfigSchema', () => {
  it('applies field defaults when an empty object is parsed', () => {
    expect(ReviewBudgetConfigSchema.parse({})).toEqual({
      enabled: false,
      summaryThreshold: 500,
      splitThreshold: 1000,
    });
  });

  it('defaults enabled to false (opt-in)', () => {
    expect(ReviewBudgetConfigSchema.parse({ summaryThreshold: 300 }).enabled).toBe(false);
  });

  it('rejects splitThreshold below summaryThreshold', () => {
    expect(() =>
      ReviewBudgetConfigSchema.parse({ summaryThreshold: 900, splitThreshold: 100 }),
    ).toThrow('splitThreshold must be >= summaryThreshold');
  });

  it('accepts splitThreshold equal to summaryThreshold', () => {
    expect(
      ReviewBudgetConfigSchema.parse({ summaryThreshold: 900, splitThreshold: 900 }),
    ).toMatchObject({ summaryThreshold: 900, splitThreshold: 900 });
  });
});

describe('MultiAgentConfigSchema', () => {
  it('applies defaults when an empty multiAgent object is parsed', () => {
    expect(MultiAgentConfigSchema.parse({})).toEqual({
      enabled: false,
      agents: {},
      synthesis: { enabled: true },
    });
  });

  it('defaults enabled to false (opt-in)', () => {
    expect(MultiAgentConfigSchema.parse({}).enabled).toBe(false);
  });

  it('parses valid agent categories and per-agent fields', () => {
    const result = MultiAgentConfigSchema.parse({
      enabled: true,
      agents: {
        security: { enabled: true, model: 'openai/gpt-4o', promptFile: 'custom.md' },
        quality: { enabled: false },
      },
      synthesis: { enabled: true, model: 'openai/gpt-4o' },
    });
    expect(result.enabled).toBe(true);
    expect(result.agents.security?.model).toBe('openai/gpt-4o');
    expect(result.agents.security?.promptFile).toBe('custom.md');
    expect(result.agents.quality?.enabled).toBe(false);
    expect(result.synthesis.model).toBe('openai/gpt-4o');
  });

  it('degrades to defaults on an unknown/mistyped agent-category key', () => {
    // A single typo (e.g. `secuirty:`) must not fail the whole parse; it
    // degrades to the defaults, mirroring NotificationsConfigSchema.
    expect(
      MultiAgentConfigSchema.parse({
        enabled: true,
        agents: { secuirty: { enabled: true } },
      }),
    ).toEqual({ enabled: false, agents: {}, synthesis: { enabled: true } });
  });

  it('does not fail when a partial agent config omits optional fields', () => {
    const result = MultiAgentConfigSchema.parse({
      enabled: true,
      agents: { security: {} },
    });
    expect(result.enabled).toBe(true);
  });
});

describe('AgentConfigSchema review budget default', () => {
  it('applies reviewBudget field defaults when omitted', () => {
    const config = AgentConfigSchema.parse({});
    expect(config.review.reviewBudget).toEqual({
      enabled: false,
      summaryThreshold: 500,
      splitThreshold: 1000,
    });
  });
});
