import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_BUDGET_MARKER, ReviewEngine } from '../src/engine.js';

const B = ReviewEngine.budgetOrchestratorContext;
describe('brutal budget contract', () => {
  it('multibyte bomb stays within budget in bytes', () => {
    const r = B('🔥'.repeat(50000), 45000);
    expect(r.wasBudgeted).toBe(true);
    expect(Buffer.byteLength(r.context, 'utf8')).toBeLessThanOrEqual(45000);
  });
  it('marker literal in diff does not force budgeting by itself', () => {
    const r = B('x'.repeat(100) + ORCHESTRATOR_BUDGET_MARKER, 100000);
    expect(r.wasBudgeted).toBe(false);
  });
  it('degenerate tiny budget still honors byte cap', () => {
    const r = B('x'.repeat(1000), 5);
    expect(r.wasBudgeted).toBe(true);
    expect(Buffer.byteLength(r.context, 'utf8')).toBeLessThanOrEqual(5);
  });
  it('empty input passes through', () => {
    expect(B('', 100)).toEqual({ context: '', wasBudgeted: false });
  });
});
