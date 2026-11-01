import { describe, expect, it } from 'vitest';
import {
  GATE_SEVERITIES,
  type GateResultInput,
  computeMaxSeverity,
  evaluateGate,
  formatGateSummary,
  parseGateSeverity,
} from '../src/gate.js';

function makeResult(overrides: Partial<GateResultInput> = {}): GateResultInput {
  return {
    stats: { critical: 0, important: 0, minor: 0 },
    issues: [],
    ...overrides,
  };
}

describe('parseGateSeverity', () => {
  it.each(GATE_SEVERITIES)('accepts the canonical tier %s', (tier) => {
    expect(parseGateSeverity(tier)).toBe(tier);
  });

  it('accepts native severity aliases and normalizes case/whitespace', () => {
    expect(parseGateSeverity('minor')).toBe('minor');
    expect(parseGateSeverity('important')).toBe('important');
    expect(parseGateSeverity('  HIGH ')).toBe('high');
  });

  it('rejects unknown values', () => {
    expect(parseGateSeverity('bogus')).toBeUndefined();
    expect(parseGateSeverity('')).toBeUndefined();
  });
});

describe('computeMaxSeverity', () => {
  it('prefers stats counts', () => {
    expect(computeMaxSeverity(makeResult({ stats: { critical: 0, important: 2, minor: 5 } }))).toBe(
      'important',
    );
    expect(computeMaxSeverity(makeResult({ stats: { critical: 1, important: 2, minor: 5 } }))).toBe(
      'critical',
    );
  });

  it('returns undefined when there are no findings', () => {
    expect(computeMaxSeverity(makeResult())).toBeUndefined();
  });

  it('derives from issues when stats are missing', () => {
    const result = makeResult({
      stats: undefined,
      issues: [{ severity: 'minor' }, { severity: 'critical' }, { severity: 'important' }],
    });
    expect(computeMaxSeverity(result)).toBe('critical');
  });

  it('derives from issues when stats are non-numeric', () => {
    const result = makeResult({
      stats: { critical: 'x', important: 0, minor: 0 },
      issues: [{ severity: 'important' }],
    });
    expect(computeMaxSeverity(result)).toBe('important');
  });

  it('returns undefined for malformed severities', () => {
    const result = makeResult({
      stats: undefined,
      issues: [{ severity: 'bogus' }],
    });
    expect(computeMaxSeverity(result)).toBeUndefined();
  });
});

describe('evaluateGate', () => {
  it('passes when the max severity is below the threshold', () => {
    const evaluation = evaluateGate(
      makeResult({ stats: { critical: 0, important: 1, minor: 0 } }),
      'high',
    );
    expect(evaluation).toEqual({ passed: true, maxSeverity: 'important', inconclusive: false });
  });

  it('fails when a finding meets the threshold', () => {
    const evaluation = evaluateGate(
      makeResult({ stats: { critical: 1, important: 0, minor: 0 } }),
      'high',
    );
    expect(evaluation).toEqual({ passed: false, maxSeverity: 'critical', inconclusive: false });
  });

  it('treats info and low as the same minor threshold', () => {
    const result = makeResult({ stats: { critical: 0, important: 0, minor: 1 } });
    expect(evaluateGate(result, 'info').passed).toBe(false);
    expect(evaluateGate(result, 'low').passed).toBe(false);
  });

  it('marks missing or malformed severity data as inconclusive', () => {
    const result = makeResult({ stats: undefined, issues: [{ severity: 'bogus' }] });
    expect(evaluateGate(result, 'high')).toEqual({
      passed: false,
      inconclusive: true,
    });
  });
});

describe('formatGateSummary', () => {
  it('maps the native severity back to the user-facing gate label', () => {
    expect(formatGateSummary('high', 'important', true)).toBe('gate=high max=medium result=pass');
    expect(formatGateSummary('high', 'critical', false)).toBe('gate=high max=high result=fail');
  });

  it('reports none when there are no findings', () => {
    expect(formatGateSummary('low', undefined, true)).toBe('gate=low max=none result=pass');
  });
});
