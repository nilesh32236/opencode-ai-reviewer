import { describe, expect, it } from 'vitest';
import {
  MAX_INSTRUCTION_EXTRACT_CHARS,
  MAX_INSTRUCTION_SECTION_CHARS,
  assertOperatorInstructionBudgetOrder,
} from '../../src/utils/operator-instruction.js';

describe('operator-instruction budgets', () => {
  it('keeps the section cap at or below the extract cap', () => {
    // The two halves of the prompt-injection control disagree by 3x when they
    // are independent constants. The section may only ever shrink what
    // extraction retained, never grow it.
    expect(MAX_INSTRUCTION_SECTION_CHARS).toBeLessThanOrEqual(MAX_INSTRUCTION_EXTRACT_CHARS);
    expect(() => assertOperatorInstructionBudgetOrder()).not.toThrow();
  });

  it('pins both budgets so a raise of one cannot silently skip the other', () => {
    expect(MAX_INSTRUCTION_EXTRACT_CHARS).toBe(6000);
    expect(MAX_INSTRUCTION_SECTION_CHARS).toBe(2000);
  });
});
