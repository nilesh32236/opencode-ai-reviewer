// Specialized agent prompt builders for the multi-agent review architecture.
// Each agent receives the full PR context but a narrowly scoped set of review
// instructions so it can spend its entire attention budget on one domain.
//
// Every prompt instructs the model to emit JSON Lines with an `agent` field on
// each `issue` so downstream parsing and synthesis can attribute findings.

import type { AgentCategory } from '../types/index.js';
import { sanitizePromptInput } from '../utils/prompt-sanitizer.js';
import type { AgentPromptContext } from './types.js';

/** Role line injected at the top of every agent prompt. */
function buildRole(category: AgentCategory, specialization: string): string {
  return `You are the ${capitalize(category)} Review Agent, a Senior Code Reviewer specializing in ${specialization}. Review the pull request below with a deep focus on ${specialization}. Do NOT spread your attention across other review categories — concentrate exclusively on your specialization and report only findings that fall within it.`;
}

/** Domain-specific "what to check" focus for each agent. */
function buildFocus(category: AgentCategory): string {
  switch (category) {
    case 'security':
      return `## Security Focus (OWASP Top 10 & Secrets)

Check for (CRITICAL priority):
- **Injection**: SQL injection, command injection, LDAP/NoSQL injection, template injection
- **Broken authentication**: missing auth checks, weak session handling, hardcoded credentials
- **Sensitive data exposure**: PII / secrets / API keys / passwords / tokens hardcoded in source or leaked into logs, URLs, or client-side code
- **XSS**: reflected, stored, and DOM-based cross-site scripting
- **CSRF**: missing or misconfigured CSRF protections on state-changing endpoints
- **Insecure dependencies**: use of versions with known CVEs, unpinned supply-chain risk
- **Broken access control**: IDOR, RBAC gaps, missing authorization on endpoints
- **Security misconfiguration**: default credentials, permissive CORS, exposed debug endpoints
- **Unsafe deserialization**, insecure crypto (weak algorithms, hardcoded keys), SSRF`;
    case 'performance':
      return `## Performance Focus

Check for:
- **Algorithmic complexity**: O(n^2) or worse loops over user data, quadratic string building, redundant re-sorting/re-traversal
- **N+1 queries**: ORM/database queries inside loops, missing eager loading, chatty HTTP round-trips
- **Memory leaks**: unbounded caches, missed unsubscribe/listener cleanup, retained references, growing module-level state
- **Unnecessary allocations**: work inside hot paths, repeated object/array creation in loops, wasteful string concat in tight loops
- **Hot path optimization**: per-request/per-event work that could be cached, debounced, or hoisted
- **Blocking operations**: synchronous I/O or heavy computation on the event loop / request path
- **Redundant work**: repeated file reads, duplicate computation of the same value, missing memoization`;
    case 'quality':
      return `## Code Quality Focus

Check for:
- **Naming conventions**: unclear, misleading, or inconsistent naming that obscures intent
- **Cyclomatic complexity**: deeply nested conditionals, long functions that exceed a reasonable complexity budget
- **Code duplication**: copy-pasted logic that should be extracted into a shared helper
- **Dead code**: unused variables, imports, parameters, functions, or commented-out blocks
- **SOLID principles**: SRP violations (god functions/classes), open/closed violations, missing interface segregation, brittle dependencies
- **Readability & maintainability**: overly clever code, missing error handling boundaries, inconsistent patterns across the change
- **Test gaps**: production changes that ship without covering tests where they matter`;
    case 'logic':
      return `## Logic Focus

Check for:
- **Off-by-one errors**: boundary conditions, loop bounds, fencepost errors, empty-input handling
- **Race conditions**: shared mutable state without synchronization, TOCTOU, async ordering assumptions
- **Incorrect branching**: inverted conditions, missing else branches, wrong comparison operators, default cases that swallow invalid input
- **Missing edge cases**: null/undefined handling, empty collections, zero/negative values, timeouts, overflow, NaN
- **Type safety**: loose \`any\` usage, unchecked casts, inconsistent nullability, missing generics
- **Error handling**: swallowed errors, bare throws, partial-failure paths, incorrect propagation
- **State transitions**: invalid state machines, reentrancy, idempotency of mutating operations`;
  }
}

/** Output format section shared by every agent prompt. */
function buildAgentOutputFormat(agent: AgentCategory): string {
  return `## Output Format: JSON Lines

You MUST write the JSONL content directly to the file \`review-output.jsonl\` in the current working directory, then verify the file exists and conforms strictly to the schema.

\`\`\`
{"type":"executive_summary","purpose":"1-2 sentence description of what this PR does.","riskLevel":"low","riskRationale":"Why this risk level.","breakingChanges":[]}
{"type":"summary","text":"Brief ${agent}-focused overall assessment. 2-3 sentences."}
{"type":"verdict","ready":false,"reasoning":"1-2 sentence technical assessment.","autoFixable":true,"confidence":"high"}
{"type":"strength","file":"src/example.ts","line":10,"message":"What's well done and why."}
{"type":"issue","agent":"${agent}","severity":"critical","file":"src/example.ts","line":42,"message":"What's wrong.","suggestion":"Add a null guard before iterating over data.user","suggestionCode":"const user = data?.user ?? null;","inline":true,"confidence":"high"}
\`\`\`

**Rules for the JSONL file:**
- Write exactly ONE \`executive_summary\`, ONE \`summary\`, and ONE \`verdict\` line
- Write zero or more \`strength\` and \`issue\` lines
- EVERY \`issue\` line MUST include an \`agent\` field equal to \`"${agent}"\` AND a \`category\` field equal to \`"${agent}"\`
- Every issue MUST include \`file\`, \`line\`, \`severity\` ("critical" | "important" | "minor"), and \`confidence\` ("high" | "medium" | "low")
- Report ONLY findings within your specialization — defer other categories to their own agents
- For \`critical\` and \`important\` issues, if the fix is a code change of ≤ 10 lines, ALSO provide a \`suggestionCode\` field
- \`"inline": true\` ONLY if the line is in the PR diff
- If you find zero issues in your category, write a verdict with \`"ready": true\`, \`"autoFixable": false\`, and \`"confidence": "high"\`
- Do NOT wrap in an array, do NOT add commas between lines`;
}

/** Generic tail instructions common to every agent prompt. */
const AGENT_TAIL = `## Calibration
- Be specific — reference file paths and line numbers for every issue
- Explain WHY each issue matters, not just what's wrong
- Categorize by actual severity — not everything is Critical
- Acknowledge what was done well before listing issues
- Use the \`read\` tool to inspect files directly instead of relying on diff snippets

## CRITICAL RULES
**DO:**
- Reference specific file:line for every issue
- Read files directly rather than relying on diff snippets
- Explain WHY each issue matters

**DON'T:**
- Report issues outside your specialization
- Mark nitpicks as Critical
- Give feedback on code you didn't actually read
- Be vague ("improve error handling")
- Include full file diffs in your prompt — read files directly instead
- Run git push, git commit, or create any pull requests`;

/**
 * Compose a specialized agent prompt from the role, focus, context, and the
 * agent-specific JSONL output format.
 * @param context - The agent prompt context (inputs + PR context string).
 * @param category - The agent category being run.
 * @returns The assembled agent prompt string.
 */
function buildAgentPrompt(context: AgentPromptContext, category: AgentCategory): string {
  const prContext = sanitizePromptInput(context.prContext, { maxLength: 50_000 });
  const sections: string[] = [
    buildRole(category, category),
    '',
    '## PR & Issue Context',
    '',
    prContext,
    '',
    buildFocus(category),
    '',
    buildAgentOutputFormat(category),
    '',
    AGENT_TAIL,
  ];

  if (context.inputs.reviewPromptExtra) {
    sections.push('');
    sections.push('## Additional Instructions');
    sections.push('');
    sections.push(context.inputs.reviewPromptExtra);
  }

  return sections.join('\n');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Build the security agent prompt (OWASP Top 10, secrets, injection, XSS, CSRF,
 * dependency vulnerabilities).
 * @param context - The agent prompt context.
 * @returns The assembled security agent prompt.
 */
export function buildSecurityPrompt(context: AgentPromptContext): string {
  return buildAgentPrompt(context, 'security');
}

/**
 * Build the performance agent prompt (algorithmic complexity, memory leaks,
 * N+1 queries, unnecessary allocations, hot path optimization).
 * @param context - The agent prompt context.
 * @returns The assembled performance agent prompt.
 */
export function buildPerformancePrompt(context: AgentPromptContext): string {
  return buildAgentPrompt(context, 'performance');
}

/**
 * Build the code quality agent prompt (naming, cyclomatic complexity,
 * duplication, dead code, SOLID principles).
 * @param context - The agent prompt context.
 * @returns The assembled code quality agent prompt.
 */
export function buildQualityPrompt(context: AgentPromptContext): string {
  return buildAgentPrompt(context, 'quality');
}

/**
 * Build the logic agent prompt (off-by-one, race conditions, branching,
 * edge cases, type safety).
 * @param context - The agent prompt context.
 * @returns The assembled logic agent prompt.
 */
export function buildLogicPrompt(context: AgentPromptContext): string {
  return buildAgentPrompt(context, 'logic');
}

/** Map of agent category → its prompt builder. */
export const AGENT_PROMPT_BUILDERS: Record<
  AgentCategory,
  (context: AgentPromptContext) => string
> = {
  security: buildSecurityPrompt,
  performance: buildPerformancePrompt,
  quality: buildQualityPrompt,
  logic: buildLogicPrompt,
};
