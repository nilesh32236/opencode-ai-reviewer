import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rankContextEntries } from '../../src/mcp/context-ranker.js';
import { assessJevDiffRiskGate } from '../../src/review/jev-diff-risk.js';
import type { MCPContextEntry } from '../../src/types/index.js';
import {
  JEV_ENDPOINT,
  type JevCallOptions,
  type JevDiffRiskAssessment,
  type JevDiffRiskInput,
  type JevDiffRiskProvider,
  type JevPrefilterFinding,
  type JevRelevanceAssessment,
  type JevRelevanceProvider,
  type JevValidityAssessment,
  type JevValidityProvider,
  isJevEnabled,
  prefilterVerificationIssues,
  resetJevCircuitBreaker,
} from '../../src/utils/jev-client.js';
import {
  JEV_SDK_ENDPOINT,
  type JevProvider,
  RestJevProvider,
  SDK_JEV_PROVIDER_TODO,
  SdkJevProvider,
  createJevProvider,
  defaultJevProvider,
  resolveJevProvider,
  resolveJevProviderKind,
} from '../../src/utils/jev-provider.js';
import { Logger } from '../../src/utils/logger.js';

const ENV_KEYS = [
  'JEV_ENABLED',
  'JEV_MODEL',
  'JEV_PROVIDER',
  'JEV_TIMEOUT_MS',
  'OPENCODE_API_KEY',
  'INPUT_OPENCODE_API_KEY',
  'TYPESAFE_API_KEY',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetJevCircuitBreaker();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  resetJevCircuitBreaker();
});

/**
 * Build a unified fake provider with scripted assessments.
 *
 * @param validity - Scripted validity assessments.
 * @param relevance - Scripted relevance assessments.
 * @param risk - Scripted risk assessment.
 * @returns The fake unified provider.
 */
function fakeProvider(
  validity: JevValidityAssessment[],
  relevance: JevRelevanceAssessment[] = [],
  risk: JevDiffRiskAssessment = { level: 'unknown', reason: 'ok', unavailable: false },
): JevProvider {
  return {
    kind: 'rest',
    scoreBatch: async (_findings: JevPrefilterFinding[]) => validity,
    scoreRelevance: async (_contents: string[], _query: string) => relevance,
    assessRisk: async () => risk,
  };
}

describe('resolveJevProviderKind', () => {
  it('defaults to rest when unset, blank, or unrecognized (fail-safe)', () => {
    expect(resolveJevProviderKind({})).toBe('rest');
    expect(resolveJevProviderKind({ JEV_PROVIDER: '' })).toBe('rest');
    expect(resolveJevProviderKind({ JEV_PROVIDER: '   ' })).toBe('rest');
    expect(resolveJevProviderKind({ JEV_PROVIDER: 'sdk-v2' })).toBe('rest');
    expect(resolveJevProviderKind({ JEV_PROVIDER: 'openai' })).toBe('rest');
  });

  it('selects rest explicitly (case-insensitive, trimmed)', () => {
    expect(resolveJevProviderKind({ JEV_PROVIDER: 'rest' })).toBe('rest');
    expect(resolveJevProviderKind({ JEV_PROVIDER: ' REST ' })).toBe('rest');
  });

  it('selects sdk only on the literal sdk (case-insensitive, trimmed)', () => {
    expect(resolveJevProviderKind({ JEV_PROVIDER: 'sdk' })).toBe('sdk');
    expect(resolveJevProviderKind({ JEV_PROVIDER: ' SDK ' })).toBe('sdk');
  });

  it('fails safe to rest on non-string runtime values (never throws)', () => {
    const envOf = (value: unknown) =>
      ({ JEV_PROVIDER: value }) as unknown as Record<string, string | undefined>;
    expect(resolveJevProviderKind(envOf(42))).toBe('rest');
    expect(resolveJevProviderKind(envOf(null))).toBe('rest');
    expect(resolveJevProviderKind(envOf(true))).toBe('rest');
    expect(resolveJevProviderKind(envOf({}))).toBe('rest');
  });
});

describe('provider selection', () => {
  it('defaults to the REST provider (zero behavior change)', () => {
    const provider = createJevProvider();
    expect(provider).toBeInstanceOf(RestJevProvider);
    expect(provider.kind).toBe('rest');
    expect(defaultJevProvider).toBeInstanceOf(RestJevProvider);
    expect(defaultJevProvider.kind).toBe('rest');
  });

  it('resolveJevProvider defaults to REST and honors JEV_PROVIDER=sdk', () => {
    expect(resolveJevProvider({})).toBeInstanceOf(RestJevProvider);
    const sdk = resolveJevProvider({ JEV_PROVIDER: 'sdk' });
    expect(sdk).toBeInstanceOf(SdkJevProvider);
    expect(sdk.kind).toBe('sdk');
  });

  it('warns once at selection time when the sdk stub is selected', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const sdk = createJevProvider('sdk', { logger });
    expect(sdk).toBeInstanceOf(SdkJevProvider);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('inert');

    const viaEnv = resolveJevProvider({ JEV_PROVIDER: 'sdk' }, { logger });
    expect(viaEnv).toBeInstanceOf(SdkJevProvider);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('leaves the JEV_ENABLED=false default unchanged', () => {
    expect(isJevEnabled()).toBe(false);
    expect(isJevEnabled({})).toBe(false);
  });
});

describe('SdkJevProvider stub', () => {
  it('fails open without HTTP (unavailable/unknown, never throws)', async () => {
    const stub = new SdkJevProvider(new Logger('test-sdk-stub'));
    const explodingFetch = (async () => {
      throw new Error('must not attempt HTTP');
    }) as typeof fetch;
    const options: JevCallOptions = { fetchImpl: explodingFetch };

    const validity = await stub.scoreBatch([{ file: 'a.ts', line: 1, message: 'm' }], options);
    expect(validity).toHaveLength(1);
    expect(validity[0]?.unavailable).toBe(true);

    const relevance = await stub.scoreRelevance(['content'], 'query', options);
    expect(relevance).toHaveLength(1);
    expect(relevance[0]?.unavailable).toBe(true);

    const risk = await stub.assessRisk(
      { statLine: 's', filePaths: ['a.ts'], description: 'd' },
      options,
    );
    expect(risk.level).toBe('unknown');
    expect(risk.unavailable).toBe(true);
  });

  it('rejects on caller cancellation instead of fail-open resolve', async () => {
    const stub = new SdkJevProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(
      stub.scoreBatch([{ file: 'a.ts', line: 1, message: 'm' }], {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await expect(stub.scoreRelevance(['c'], 'q', { signal: controller.signal })).rejects.toThrow();
    await expect(
      stub.assessRisk(
        { statLine: 's', filePaths: ['a.ts'], description: 'd' },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('prefers the per-call logger override over the constructor logger', async () => {
    const ctorWarn = vi.fn();
    const callWarn = vi.fn();
    const stub = new SdkJevProvider({ warn: ctorWarn } as unknown as Logger);
    const callLogger = { warn: callWarn } as unknown as Logger;
    const finding = { file: 'a.ts', line: 1, message: 'm' };
    const riskInput = { statLine: 's', filePaths: ['a.ts'], description: 'd' };

    await stub.scoreBatch([finding], { logger: callLogger });
    await stub.scoreRelevance(['content'], 'query', { logger: callLogger });
    await stub.assessRisk(riskInput, { logger: callLogger });

    expect(callWarn).toHaveBeenCalledTimes(3);
    expect(ctorWarn).not.toHaveBeenCalled();
  });

  it('falls back to the constructor logger without a per-call override', async () => {
    const ctorWarn = vi.fn();
    const stub = new SdkJevProvider({ warn: ctorWarn } as unknown as Logger);
    await stub.scoreBatch([{ file: 'a.ts', line: 1, message: 'm' }]);
    expect(ctorWarn).toHaveBeenCalledTimes(1);
  });

  it('warns and returns [] on mistyped array input instead of silent success', async () => {
    const callWarn = vi.fn();
    const stub = new SdkJevProvider();
    const callLogger = { warn: callWarn } as unknown as Logger;

    const validity = await stub.scoreBatch('not-an-array' as unknown as [], {
      logger: callLogger,
    });
    expect(validity).toEqual([]);
    const relevance = await stub.scoreRelevance(null as unknown as [], 'q', {
      logger: callLogger,
    });
    expect(relevance).toEqual([]);
    expect(callWarn).toHaveBeenCalledTimes(4);
  });

  it('documents the exact SDK translation contract (TODO presence)', () => {
    // Single-sourced pins: the TODO BaseURL line is built from JEV_SDK_ENDPOINT
    // and the Zen gateway mention from JEV_ENDPOINT (no hardcoded drift).
    expect(SDK_JEV_PROVIDER_TODO).toContain(JEV_SDK_ENDPOINT);
    expect(SDK_JEV_PROVIDER_TODO).toContain(JEV_ENDPOINT);
    for (const needle of [
      'api.typesafe.ai/v1/systemone',
      'questions-map',
      '{ model, state, questions-map }',
      'JEV_MODEL',
      'versioned',
      'criteria',
      '@typesafe-ai/sdk',
    ]) {
      expect(SDK_JEV_PROVIDER_TODO).toContain(needle);
    }
    const source = readFileSync(
      new URL('../../src/utils/jev-provider.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('TODO(SDK)');
    expect(source).toContain('@typesafe-ai/sdk');
    expect(source).toContain('JEV_ENDPOINT');
    expect(source).toContain('${JEV_ENDPOINT}');
    expect(source).not.toContain("from '@typesafe-ai/sdk'");
    expect(source).not.toContain('from "@typesafe-ai/sdk"');
    // No import cycle: jev-client.ts must not import jev-provider.ts.
    const clientSource = readFileSync(
      new URL('../../src/utils/jev-client.ts', import.meta.url),
      'utf8',
    );
    expect(clientSource).not.toContain('jev-provider');
  });
});

describe('RestJevProvider dependency injection', () => {
  const validity: JevValidityAssessment[] = [
    { score: 0.9, confidence: 0.95, model: 'fake', unavailable: false, reason: 'ok' },
  ];
  const relevance: JevRelevanceAssessment[] = [
    { score: 0.7, confidence: 0.8, model: 'fake', unavailable: false, reason: 'ok' },
  ];
  const risk: JevDiffRiskAssessment = { level: 'low', reason: 'ok', unavailable: false };

  function scriptedDeps(calls: string[]) {
    return {
      validity: {
        scoreBatch: async () => {
          calls.push('validity');
          return validity;
        },
      } as JevValidityProvider,
      relevance: {
        scoreRelevance: async () => {
          calls.push('relevance');
          return relevance;
        },
      } as JevRelevanceProvider,
      risk: {
        assessRisk: async () => {
          calls.push('risk');
          return risk;
        },
      } as JevDiffRiskProvider,
    };
  }

  it('delegates each concern to its injected override', async () => {
    const calls: string[] = [];
    const provider = new RestJevProvider(scriptedDeps(calls));

    await expect(provider.scoreBatch([{ file: 'a.ts', line: 1, message: 'm' }])).resolves.toBe(
      validity,
    );
    await expect(provider.scoreRelevance(['content'], 'query')).resolves.toBe(relevance);
    await expect(
      provider.assessRisk({ statLine: 's', filePaths: ['a.ts'], description: 'd' }),
    ).resolves.toBe(risk);
    expect(calls).toEqual(['validity', 'relevance', 'risk']);
  });

  it('createJevProvider passes per-concern overrides through to REST', async () => {
    const calls: string[] = [];
    const provider = createJevProvider('rest', scriptedDeps(calls));
    expect(provider).toBeInstanceOf(RestJevProvider);

    const finding = { file: 'a.ts', line: 1, message: 'm' };
    await expect(provider.scoreBatch([finding])).resolves.toBe(validity);
    await expect(provider.scoreRelevance(['content'], 'query')).resolves.toBe(relevance);
    const riskInput: JevDiffRiskInput = {
      statLine: 's',
      filePaths: ['a.ts'],
      description: 'd',
    };
    await expect(provider.assessRisk(riskInput)).resolves.toBe(risk);
    expect(calls).toEqual(['validity', 'relevance', 'risk']);
  });
});

describe('seam swap-ability', () => {
  it('prefilter drops obvious FPs through a fake unified JevProvider', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    const findings: JevPrefilterFinding[] = [
      { file: 'src/a.ts', line: 1, message: 'false positive', severity: 'minor' },
      { file: 'src/b.ts', line: 2, message: 'real defect', severity: 'minor' },
    ];
    const provider = fakeProvider([
      { score: 0.0, confidence: 0.95, model: 'fake', unavailable: false, reason: 'ok' },
      { score: 0.9, confidence: 0.95, model: 'fake', unavailable: false, reason: 'ok' },
    ]);
    const result = await prefilterVerificationIssues(findings, { provider });
    expect(result.skipped).toBe(false);
    expect(result.dropped).toEqual([findings[0]]);
    expect(result.kept).toEqual([findings[1]]);
  });

  it('context ranker reorders through a fake unified JevProvider', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    const entries: MCPContextEntry[] = [
      { content: 'unrelated notes', relevance: 0.9, source: 's' },
      { content: 'auth migration plan', relevance: 0.1, source: 's' },
    ];
    const provider = fakeProvider(
      [],
      [
        { score: 0.0, confidence: 0.95, model: 'fake', unavailable: false, reason: 'ok' },
        { score: 0.95, confidence: 0.95, model: 'fake', unavailable: false, reason: 'ok' },
      ],
    );
    const ranked = await rankContextEntries(entries, 'auth migration review', { provider });
    expect(ranked[0]?.content).toBe('auth migration plan');
    expect(ranked[1]?.content).toBe('unrelated notes');
  });

  it('diff-risk gate consumes a fake unified JevProvider without HTTP', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    const provider = fakeProvider([], [], {
      level: 'high',
      reason: 'ok',
      model: 'fake',
      unavailable: false,
    });
    const result = await assessJevDiffRiskGate(
      { deterministic: 'summary', totalDiffLines: 10, filePaths: ['src/a.ts'], title: 't' },
      { provider },
    );
    expect(result.budgetMode).toBe('full');
    expect(result.level).toBe('high');
  });

  it('RestJevProvider fails open while disabled (no HTTP, REST default)', async () => {
    const provider = new RestJevProvider();
    const explodingFetch = (async () => {
      throw new Error('must not attempt HTTP while disabled');
    }) as typeof fetch;
    const validity = await provider.scoreBatch([{ file: 'a.ts', line: 1, message: 'm' }], {
      fetchImpl: explodingFetch,
    });
    expect(validity[0]?.unavailable).toBe(true);
    const relevance = await provider.scoreRelevance(['content'], 'query', {
      fetchImpl: explodingFetch,
    });
    expect(relevance[0]?.unavailable).toBe(true);
    const risk = await provider.assessRisk(
      { statLine: 's', filePaths: ['a.ts'], description: 'd' },
      { fetchImpl: explodingFetch },
    );
    expect(risk.level).toBe('unknown');
  });
});
