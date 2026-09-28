/**
 * Operator-instruction length budgets, in one place.
 *
 * A `/fix` (or `/oc`) comment remainder travels through two distinct stages,
 * and the two stages have *different* jobs — which is why they must not share
 * a single anonymous "the cap" constant:
 *
 * 1. **Classification** ({@link MAX_OPERATOR_INSTRUCTION_CLASSIFY_CHARS}) —
 *    how much of a raw comment body is considered to be the operator
 *    instruction at all. This is a *read window*: it decides how much text is
 *    routed into the instruction, and nothing more. Marker:
 *    {@link OPERATOR_INSTRUCTION_TRUNCATION_MARKER}.
 * 2. **Prompt budget** ({@link MAX_OPERATOR_INSTRUCTION_PROMPT_CHARS}) — how
 *    much of that classified text is actually appended to the fix-agent
 *    context. This is the security boundary: it bounds the prompt-injection
 *    blast radius of a crafted `/fix` remainder, and is enforced in
 *    `buildOperatorInstructionSection`. Marker: the in-function
 *    `\n…[truncated N chars: …]…` suffix.
 *
 * The invariant that links them: the classification window must be **>=** the
 * prompt budget, otherwise classification would silently drop text before the
 * prompt cap ever had a chance to truncate it. Raising the prompt budget
 * therefore widens the injection blast radius and is a security-relevant
 * change; raising the classification window is only a UX change. Keep the
 * two named so neither can be mistaken for the other.
 */

/**
 * Maximum characters of a raw `/fix` comment body treated as the operator
 * instruction during classification (`extractOperatorInstruction`).
 * Deliberately small so a pasted CI log cannot blow up the fix prompt.
 */
export const MAX_OPERATOR_INSTRUCTION_CLASSIFY_CHARS = 6000;

/**
 * Maximum operator-instruction characters appended to fix-agent context
 * (`buildOperatorInstructionSection`). Bounds the prompt-injection blast
 * radius: a crafted `/fix` remainder cannot steer tool use beyond this quoted,
 * delimited budget.
 */
export const MAX_OPERATOR_INSTRUCTION_PROMPT_CHARS = 2000;

/** Marker appended when an operator instruction is truncated to the classify cap. */
export const OPERATOR_INSTRUCTION_TRUNCATION_MARKER = '\n\n[truncated]';
