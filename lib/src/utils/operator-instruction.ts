/**
 * Single owner for the prompt-injection character budgets applied to
 * operator instructions extracted from `/fix` trigger comments.
 *
 * `action/src/comment-commands.ts` (extraction) and `action/src/fix.ts`
 * (prompt-section assembly) previously each exported their own
 * `MAX_OPERATOR_INSTRUCTION_CHARS` (6000 vs 2000) under the same name, so
 * the two halves of the same control disagreed by 3x and any consumer
 * importing the name got a coin flip. Both modules must import from here.
 */

/**
 * Maximum operator-instruction length (chars) accepted at extraction time.
 * Deliberately small so a pasted log cannot blow up the fix prompt.
 */
export const MAX_INSTRUCTION_EXTRACT_CHARS = 6000;

/**
 * Maximum operator-instruction characters appended to fix-agent context.
 * Bounds prompt-injection blast radius: a crafted /fix remainder cannot
 * steer tool use beyond this quoted, delimited budget.
 */
export const MAX_INSTRUCTION_SECTION_CHARS = 2000;

/** Marker appended when an extracted operator instruction is truncated. */
export const OPERATOR_INSTRUCTION_TRUNCATION_MARKER = '\n\n[truncated]';
