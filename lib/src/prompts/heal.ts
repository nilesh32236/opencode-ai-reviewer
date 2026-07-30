/** Configuration inputs for building the self-heal prompt. */
export interface SelfHealPromptInputs {
  /** Optional description of the project context and conventions. */
  projectContext?: string;
  /** Maximum number of heal retry attempts allowed. */
  maxRetries?: number;
}

/**
 * Build a prompt for self-healing CI failures.
 * Instructs the AI to diagnose the root cause, apply a fix, and verify the fix.
 * Includes structured instructions for using Context7 and web search.
 *
 * @param inputs - Configuration inputs (project context, max retries).
 * @param ciFailureLogs - The CI failure output/logs.
 * @param failedStep - The name of the CI step that failed (e.g., 'Build lib', 'Unit tests').
 * @param failedWorkflow - The workflow that failed (e.g., 'CI', 'self-improvement').
 * @param previousAttemptError - Optional error output from a previous heal attempt.
 * @returns The assembled self-heal prompt string.
 */
export function buildSelfHealPrompt(
  inputs: SelfHealPromptInputs,
  ciFailureLogs: string,
  failedStep?: string,
  failedWorkflow?: string,
  previousAttemptError?: string,
): string {
  const sections: string[] = [];

  sections.push('# Self-Healing Agent: Diagnose & Fix CI Failure');
  sections.push('');
  sections.push(
    'You are a Self-Healing CI Agent for a codebase. A CI pipeline has failed, and your job is to:',
  );
  sections.push('1. **Diagnose** the root cause of the failure');
  sections.push('2. **Fix** the issue in the source code');
  sections.push('3. **Verify** your fix compiles and passes tests');
  sections.push('');

  if (inputs.projectContext) {
    sections.push('## Project Context');
    sections.push('');
    sections.push(inputs.projectContext);
    sections.push('');
  }

  sections.push('## CI Failure Details');
  sections.push('');
  if (failedWorkflow) {
    sections.push(`**Failed Workflow:** \`${failedWorkflow}\``);
  }
  if (failedStep) {
    sections.push(`**Failed Step:** \`${failedStep}\``);
  }
  sections.push('');
  sections.push('### Failure Logs');
  sections.push('');
  sections.push('```');
  sections.push(extractRelevantLogSnippet(ciFailureLogs, 12000));
  sections.push('```');
  sections.push('');

  if (previousAttemptError) {
    sections.push('## Previous Heal Attempt Failed');
    sections.push('');
    sections.push(
      'A previous attempt to fix this issue was made but verification still failed. Learn from this output:',
    );
    sections.push('');
    sections.push('```');
    const maxPrevLength = 4000;
    const truncatedPrev =
      previousAttemptError.length > maxPrevLength
        ? `[...truncated...]\n${previousAttemptError.slice(-maxPrevLength)}`
        : previousAttemptError;
    sections.push(truncatedPrev);
    sections.push('```');
    sections.push('');
  }

  sections.push('## Research Instructions (MANDATORY)');
  sections.push('');
  sections.push('Before writing any fix, you MUST research the problem:');
  sections.push('');
  sections.push('### Context7 MCP (for library/API issues)');
  sections.push('');
  sections.push(
    '1. If the error involves a library (Probot, Vitest, @actions/core, better-sqlite3, etc.):',
  );
  sections.push(
    '   - Query Context7 for the latest API docs: use the `resolve` and `docs` tools on the Context7 MCP server',
  );
  sections.push(
    '   - Alternatively: `npx ctx7@latest library <name> "<question>"` then `npx ctx7@latest docs <libraryId> "<question>"`',
  );
  sections.push('2. Check for deprecated APIs or breaking changes in the library version used');
  sections.push(
    '3. Never assume cached docs are correct — always verify against Context7 for current APIs',
  );
  sections.push('');
  sections.push('### Web Search (for debugging unknown errors)');
  sections.push('');
  sections.push('1. Use the `search_web` tool to search for:');
  sections.push('   - The exact error message (in quotes) + the relevant package name');
  sections.push('   - GitHub issues in the relevant repository');
  sections.push('   - StackOverflow threads about the error pattern');
  sections.push('2. Look for known issues, version-specific bugs, or migration guides');
  sections.push('3. Check if the error is a known Node.js / TypeScript version incompatibility');
  sections.push('');

  sections.push('## Diagnosis Steps');
  sections.push('');
  sections.push('1. **Classify the failure type:**');
  sections.push('   - `build-error`: TypeScript compilation failure');
  sections.push('   - `test-failure`: Unit test assertion failure or test crash');
  sections.push('   - `lint-error`: Biome/ESLint style violation');
  sections.push('   - `dependency-issue`: Missing/incompatible dependency');
  sections.push('   - `type-error`: TypeScript strict mode violation');
  sections.push('   - `runtime-error`: Process crash or unhandled exception');
  sections.push('2. **Identify the exact file(s) and line(s)** from the error output');
  sections.push('3. **Read the relevant source files** to understand the context');
  sections.push(
    '4. **Determine the root cause** — is it a logic error, API change, or merge conflict?',
  );
  sections.push('');

  sections.push('## Fix Rules');
  sections.push('');
  sections.push('- **Minimal changes**: Fix ONLY what is broken. Do not refactor unrelated code.');
  sections.push(
    '- **ESM imports**: All relative TypeScript imports MUST end with `.js` extension (e.g., `import { foo } from "./bar.js"`).',
  );
  sections.push('- **No `any` type**: Use explicit interfaces and types.');
  sections.push('- **Preserve comments and docstrings**: Do not remove existing documentation.');
  sections.push('- **Test your fix**: After applying changes, run the verification commands.');
  sections.push('');

  sections.push('## Verification (MANDATORY)');
  sections.push('');
  sections.push('After fixing, run these commands in order and fix any errors:');
  sections.push('1. `pnpm build` — must exit 0');
  sections.push('2. `pnpm typecheck` — must exit 0');
  sections.push('3. `pnpm test` — all tests must pass');
  sections.push('4. `pnpm lint` — no errors');
  sections.push('');
  sections.push(
    'If any step fails, diagnose the new error, fix it, and re-run. Do NOT stop until all four pass.',
  );
  sections.push('');

  sections.push('## Output');
  sections.push('');
  sections.push('Write a diagnosis report to `.opencode/heal-diagnosis.md` containing:');
  sections.push('');
  sections.push('```markdown');
  sections.push('# Self-Heal Diagnosis');
  sections.push('');
  sections.push('## Failure Classification');
  sections.push('<!-- e.g., build-error, test-failure, lint-error -->');
  sections.push('');
  sections.push('## Root Cause');
  sections.push('<!-- Detailed explanation of what went wrong -->');
  sections.push('');
  sections.push('## Fix Applied');
  sections.push('<!-- What you changed and why -->');
  sections.push('');
  sections.push('## Files Modified');
  sections.push('<!-- List of files changed -->');
  sections.push('');
  sections.push('## Verification Results');
  sections.push('<!-- Output of build/typecheck/test/lint -->');
  sections.push('```');
  sections.push('');

  sections.push('## IMPORTANT — Git Operations');
  sections.push('');
  sections.push('Do NOT run git add / git commit / git push yourself.');
  sections.push('The workflow step after you finish will handle all git operations.');

  return sections.join('\n');
}

/**
 * Intelligently extract the most relevant snippet from long CI failure logs.
 * Prioritizes failure markers (e.g. "FAIL", "Error:", "::error::") and includes
 * both header context (what command ran) and failure traceback details.
 */
export function extractRelevantLogSnippet(logs: string, maxLength = 12000): string {
  if (logs.length <= maxLength) {
    return logs;
  }

  // Look for error markers in the logs
  const errorRegex = /(?:FAIL|Error:|FAILED|::error::|npm error|vitest|stderr|exit code [1-9])/i;
  const match = errorRegex.exec(logs);

  if (match && match.index >= 0) {
    // Window starting 1000 chars before the first error match
    const matchIndex = match.index;
    const start = Math.max(0, matchIndex - 1000);
    const end = Math.min(logs.length, start + maxLength);
    const snippet = logs.slice(start, end);
    return `[...truncated leading ${start} bytes...]\n${snippet}\n[...truncated trailing ${logs.length - end} bytes...]`;
  }

  // Fallback: Combine head (2500 chars) and tail (maxLength - 2500 chars)
  const headSize = 2500;
  const tailSize = maxLength - headSize;
  const head = logs.slice(0, headSize);
  const tail = logs.slice(-tailSize);
  return `${head}\n\n[...truncated ${logs.length - maxLength} bytes...]\n\n${tail}`;
}
