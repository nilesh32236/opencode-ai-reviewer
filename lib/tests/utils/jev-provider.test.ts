import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rankContextEntries } from '../../src/mcp/context-ranker.js';
import { assessJevDiffRiskGate } from '../../src/review/jev-diff-risk.js';
import type { MCPContextEntry } from '../../src/types/index.js';
import {
  type JevCallOptions,
  type JevDiffRiskAssessment,
  type JevPrefilterFinding,
  type JevRelevanceAssessment,
  type JevValidityAssessment,
  isJevEnabled,
  prefilterVerificationIssues,
  resetJevCircuitBreaker,
} from '../../src/utils/jev-client.js';
import {
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

  it('documents the exact SDK translation contract (TODO presence)', () => {
    for (const needle of [
      'api.typesafe.ai/v1/systemone',
      'questions-array',
      'questions-map',
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
    expect(source).not.toContain("from '@typesafe-ai/sdk'");
    expect(source).not.toContain('from "@typesafe-ai/sdk"');
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
    const risk = await provider.assessRisk(
      { statLine: 's', filePaths: ['a.ts'], description: 'd' },
      { fetchImpl: explodingFetch },
    );
    expect(risk.level).toBe('unknown');
  });
});
