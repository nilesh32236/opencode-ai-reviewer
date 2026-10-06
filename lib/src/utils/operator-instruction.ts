/**
 * Single owner for the operator-instruction character budgets.
 *
 * `action/src/comment-commands.ts` and `action/src/fix.ts` each exported a
 * constant named `MAX_OPERATOR_INSTRUCTION_CHARS` with a different value
 * (6000 and 2000). Both landed in the shipped type surface, both halves of the
 * same prompt-injection control disagreed by 3x, and any import of the name got
 * a coin flip on which budget it was. Two distinct caps are genuinely intended
 * — extraction keeps more text than the fix-agent section does — so this module
 * owns both under distinct, self-documenting names.
 *
 * The invariant is {@link MAX_INSTRUCTION_SECTION_CHARS} <= {@link MAX_INSTRUCTION_EXTRACT_CHARS}:
 * the section cap may only ever shrink what extraction produced, never grow it.
 * {@link assertOperatorInstructionBudgetOrder} pins that at module load so the
 * order cannot invert silently.
 */

/**
 * Maximum operator-instruction length (chars) retained by comment-command
 * extraction. Deliberately small so a pasted log cannot blow up the fix prompt.
 */
export const MAX_INSTRUCTION_EXTRACT_CHARS = 6000;

/**
 * Maximum operator-instruction length (chars) appended to fix-agent context.
 * Bounds prompt-injection blast radius: a crafted `/fix` remainder cannot
 * steer tool use beyond this quoted, delimited budget.
 */
export const MAX_INSTRUCTION_SECTION_CHARS = 2000;

/**
 * Throw when the section cap exceeds the extract cap, which would let the
 * prompt-assembly stage admit more text than extraction ever retained.
 * Called at module load so the invariant is enforced by import, not by a test
 * that can be skipped.
 */
export function assertOperatorInstructionBudgetOrder(): void {
  if (MAX_INSTRUCTION_SECTION_CHARS > MAX_INSTRUCTION_EXTRACT_CHARS) {
    throw new Error(
      `Invalid operator-instruction budgets: section cap (${MAX_INSTRUCTION_SECTION_CHARS}) must be <= extract cap (${MAX_INSTRUCTION_EXTRACT_CHARS})`,
    );
  }
}

assertOperatorInstructionBudgetOrder();
