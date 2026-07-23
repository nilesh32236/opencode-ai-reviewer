import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import type { PreviousFindingIteration, ReviewIssue } from '../types/index.js';

interface PromptBuilderInputs {
  reviewPromptFile?: string;
  reviewPromptExtra?: string;
  maxFilesPerBatch?: number;
  projectContext?: string;
  runChecksAfterFix?: string;
  maxFixIterations?: number;
}

/**
 * Build the review prompt string from inputs and PR context.
 * @param inputs - Configuration inputs including optional custom prompt file, project context, etc.
 * @param prContext - The PR context string describing the pull request.
 * @param lessons - Optional array of learned lessons from previous reviews.
 * @returns The assembled review prompt string.
 */
export function buildReviewPrompt(
  inputs: PromptBuilderInputs,
  prContext: string,
  lessons?: string[],
  previousFindings?: PreviousFindingIteration[],
): string {
  if (inputs.reviewPromptFile) {
    const customPrompt = loadPromptFile(inputs.reviewPromptFile);
    if (customPrompt) {
      return customPrompt + (inputs.reviewPromptExtra ? '\n\n' + inputs.reviewPromptExtra : '');
    }
  }

  const projectContext = inputs.projectContext || getDefaultProjectContext();
  const sections: string[] = [];

  sections.push(
    'You are a Senior Code Reviewer with deep expertise in software architecture, design patterns, and best practices. Review this pull request thoroughly.',
  );

  sections.push('\n## PR & Issue Context');
  sections.push('');
  sections.push(prContext);

  sections.push('\n## Project Context');
  sections.push('');
  sections.push(projectContext);

  sections.push('\n## Context Window Management');
  sections.push('');
  sections.push(
    'This repository may be too large to review in one pass. Your review is focused on a specific subset of files from a larger PR.',
  );
  sections.push('');
  sections.push(
    '1. Use the `read` tool to view each changed file directly (do NOT include full diffs in the prompt).',
  );
  sections.push('2. Review the provided file list thoroughly.');
  sections.push('3. If any single file exceeds 300 lines, read and review it separately.');

  sections.push('\n' + buildWhatToCheck());

  sections.push('\n## Calibration');
  sections.push('');
  sections.push(
    "Be specific — reference file paths and line numbers for every issue. Explain WHY each issue matters, not just what's wrong. Categorize by actual severity — not everything is Critical. Acknowledge what was done well before listing issues.",
  );
  sections.push('');
  sections.push('If you find significant deviations from the PR intent, flag them specifically.');
  sections.push('');
  sections.push('## Severity Guide');
  sections.push('');
  sections.push(
    '- **critical**: Bug, security hole, broken functionality, HTML spec violation, PII exposure — must fix before merge',
  );
  sections.push(
    '- **important**: Architecture concern, maintainability debt, significant duplication, missing error handling, accessibility gaps — should fix',
  );
  sections.push(
    '- **minor**: Style, naming, optimization, documentation, small refactors — nice to have',
  );

  sections.push('\n## Output Format: JSON Lines');
  sections.push('');
  sections.push(buildOutputFormat());

  if (lessons && lessons.length > 0) {
    sections.push('\n## Historical Lessons');
    sections.push('');
    sections.push('The following patterns were detected in similar code in past reviews:');
    sections.push('');
    for (const lesson of lessons) {
      sections.push(`- ${lesson}`);
    }
  }

  if (previousFindings && previousFindings.length > 0) {
    sections.push('\n## Previous Review Iterations');
    sections.push('');
    sections.push(
      'This is not the first review of this PR. Issues were previously found and fixes were applied. Review ONLY the current state and report only issues that are STILL present.',
    );
    sections.push('');
    for (const pf of previousFindings) {
      sections.push(`### Iteration ${pf.iteration}`);
      sections.push('');
      if (pf.fixSummary) {
        sections.push(`Fix summary: ${pf.fixSummary}`);
        sections.push('');
      }
      if (pf.filesChanged && pf.filesChanged.length > 0) {
        sections.push(`Files changed: \`${pf.filesChanged.join('`, `')}\``);
        sections.push('');
      }
      sections.push('Previously reported issues:');
      for (const issue of pf.issues) {
        const tag = issue.previouslyReported ? ' (previously reported — verify fixed)' : '';
        sections.push(
          `- **${issue.severity.toUpperCase()}:** ${issue.file}:${issue.line} — ${issue.message}${tag}`,
        );
        if (issue.suggestion) {
          sections.push(`  > Suggestion: ${issue.suggestion}`);
        }
      }
      sections.push('');
    }
    sections.push(
      '**IMPORTANT:** Do NOT re-report issues that have already been fixed. Only flag issues that are still present in the current code. If an issue from a previous iteration persists, mark it with `"previouslyReported": true` in the JSONL output.',
    );
  }

  sections.push('\n## Critical Rules');
  sections.push('');
  sections.push('**DO:**');
  sections.push('- Reference specific file:line for every issue');
  sections.push('- Use the `read` tool to view file contents instead of relying on diff snippets');
  sections.push('- Explain WHY each issue matters');
  sections.push('- Categorize by actual severity');
  sections.push('- Acknowledge strengths before issues');
  sections.push('- Give a clear verdict');
  sections.push('');
  sections.push("**DON'T:**");
  sections.push('- Say "looks good" without checking');
  sections.push('- Mark nitpicks as Critical');
  sections.push("- Give feedback on code you didn't actually read");
  sections.push('- Be vague ("improve error handling")');
  sections.push('- Avoid giving a clear verdict');
  sections.push('- Include full file diffs in your prompt — read files directly instead');
  sections.push('- Run git push, git commit, or create any pull requests');

  if (inputs.reviewPromptExtra) {
    sections.push('\n## Additional Instructions');
    sections.push('');
    sections.push(inputs.reviewPromptExtra);
  }

  return sections.join('\n');
}

/**
 * Build the fix prompt for automated code fixing.
 * Includes issues to fix sorted by severity, verification errors,
 * and iteration context for the fix loop.
 *
 * @param inputs - Configuration inputs.
 * @param context - Full context (issue + PR + review comments).
 * @param iteration - Current fix iteration (0-indexed).
 * @param issues - Issues to fix, sorted by severity.
 * @param verificationError - Optional verification error from previous attempt.
 * @returns The assembled fix prompt string.
 */
export function buildFixPrompt(
  inputs: PromptBuilderInputs,
  context: string,
  iteration: number,
  issues?: ReviewIssue[],
  verificationError?: string,
): string {
  const projectContext = inputs.projectContext || getDefaultProjectContext();
  const maxIterations = inputs.maxFixIterations ?? 3;

  let issuesBlock = '';
  if (issues && issues.length > 0) {
    const sorted = [...issues].sort((a, b) => {
      const order: Record<string, number> = { critical: 0, important: 1, minor: 2 };
      return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
    });
    issuesBlock = '\n## Issues to Fix (Iteration ' + (iteration + 1) + ')\n\n';
    for (let idx = 0; idx < sorted.length; idx++) {
      const issue = sorted[idx];
      issuesBlock += `${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.file}:${issue.line} — ${issue.message}\n`;
      if (issue.suggestion) {
        issuesBlock += `   Suggestion: ${issue.suggestion}\n`;
      }
    }
  }

  const contextBlock = issuesBlock ? context + '\n\n---\n' + issuesBlock : context;

  const instructions =
    issues && issues.length > 0
      ? 'Fix the issues listed below in order of severity. Skip any that are already resolved.'
      : 'Read ALL the review comments above carefully. Focus on:\n1. Issues marked as CRITICAL — these must be fixed\n2. Issues marked as IMPORTANT — these should be fixed\n3. Issues marked as MINOR — fix these if straightforward';

  const verificationSection = verificationError
    ? `\n\n## Verification Error (Previous Attempt Failed)\n\nThe previous fix attempt produced errors during build/check verification. The raw output was:\n\n\`\`\`\n${verificationError}\n\`\`\`\n\nPlease fix these compilation/lint errors in your current attempt. Ensure the code compiles and passes all checks before finishing.\n`
    : '';

  const prompt = `You are a Senior Code Fixer. Fix the issues found during code review.

## Full Context (Issue + PR + Review Comments)

${contextBlock}

${verificationSection}
---

## Fix Iteration: ${iteration} of ${maxIterations}

${instructions}

## Project Context
${projectContext}

## Steps
1. Read and understand each issue from the review feedback above
2. For each issue, open the referenced file at the reported line
3. Apply a minimal, correct fix
4. After fixing, run verification commands${inputs.runChecksAfterFix ? ': ' + inputs.runChecksAfterFix : ' (if configured)'}
5. Fix any errors introduced by your changes
6. Write a detailed summary of what you fixed and what you skipped (if anything) in markdown format to the file \`.fix-summary.md\`.

## CRITICAL RULES
- Do NOT run \`git push\`, \`git commit\`, or create any pull requests
- Do NOT run any git commands at all — the workflow handles git operations
- Fix ONLY the issues from the review feedback — nothing more
- Prefer minimal, targeted fixes over rewrites
- Do not add features or change unrelated code
- If a fix requires significant refactoring outside scope, skip it
- Verify every change compiles before finishing`;

  return prompt;
}

/**
 * Build the audit prompt for a specific audit category.
 * Instructs the LLM to audit a target directory against a category-specific prompt.
 *
 * @param inputs - Configuration inputs including project context.
 * @param categoryPrompt - The category-specific audit prompt text.
 * @param targetDir - Directory path to audit.
 * @param category - Audit category name (used for output filename).
 * @returns The assembled audit prompt string.
 */
export function buildAuditPrompt(
  inputs: PromptBuilderInputs,
  categoryPrompt: string,
  targetDir: string,
  category: string,
): string {
  const projectContext = inputs.projectContext || getDefaultProjectContext();

  return `${categoryPrompt}

---

Audit the directory: \`${targetDir}\`

## Project Context
${projectContext}

Context window management:
- If the target directory has more than 15 files, batch them into groups of at most 5 files.
- Collect all results before writing the final output.
- If any single file exceeds 300 lines, audit it separately.

For each finding:
- Reference the specific file path and line number
- Explain WHY the issue matters, not just what is wrong
- Categorize by actual severity — not everything is Critical

Safety rules:
- Do not modify any files — this is a read-only audit
- Do NOT run git push, git commit, or create any pull requests

Write your findings in JSON Lines format to the file \`.opencode/audit-${category}.jsonl\`.
After writing the file, you MUST verify that the JSONL file exists, is valid JSONL, and conforms strictly to the specified schema and rules.

{"type":"summary","text":"overall assessment"}
{"type":"issue","severity":"critical|important|minor","file":"path","line":N,"message":"what's wrong","suggestion":"how to fix","inline":false}`;
}

/**
 * Load a custom prompt file from the workspace directory.
 * Validates that the file path resolves within the workspace for security.
 *
 * @param filePath - Path relative to the workspace root.
 * @returns The file content, or null if the path is invalid or the file is unreadable.
 */
export function loadPromptFile(filePath: string): string | null {
  const workspace = fs.realpathSync(process.cwd());
  const resolved = path.resolve(workspace, filePath);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith('..')) return null;
  try {
    const realPath = fs.realpathSync(resolved);
    const realRelative = path.relative(workspace, realPath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      core.warning(`Rejected prompt file load: ${filePath} resolves outside workspace.`);
      return null;
    }
    return fs.readFileSync(realPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Load an audit category prompt from the configured prompts directory.
 * Searches `.audit-prompts/` and `prompts/audit-categories/` by default.
 * Rejects symbolic links and paths outside the workspace for security.
 *
 * @param category - Category name (corresponds to a `.md` file).
 * @param promptsDir - Optional custom prompts directory.
 * @returns The prompt text, or null if not found.
 */
export function loadAuditCategoryPrompt(category: string, promptsDir?: string): string | null {
  const workspace = fs.realpathSync(process.cwd());
  const dirs = promptsDir
    ? [promptsDir]
    : [path.resolve('.audit-prompts'), path.resolve('prompts/audit-categories')];

  for (const dir of dirs) {
    const filePath = path.resolve(dir, `${category}.md`);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        core.warning(`Rejected audit category prompt load: ${filePath} is a symbolic link.`);
        continue;
      }
      const realPath = fs.realpathSync(filePath);
      const relative = path.relative(workspace, realPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        core.warning(
          `Rejected audit category prompt load: ${filePath} resolves outside workspace.`,
        );
        continue;
      }
      return fs.readFileSync(realPath, 'utf-8');
    } catch {}
  }

  return null;
}

/**
 * List available audit categories by scanning prompts directories for `.md` files.
 *
 * @param promptsDir - Optional custom prompts directory.
 * @returns Sorted array of category names (without `.md` extension).
 */
export function listAuditCategories(promptsDir?: string): string[] {
  const workspace = fs.realpathSync(process.cwd());
  const dirs = promptsDir
    ? [promptsDir]
    : [path.resolve('.audit-prompts'), path.resolve('prompts/audit-categories')];

  const categories: Set<string> = new Set();
  for (const dir of dirs) {
    try {
      const dirStat = fs.lstatSync(dir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) continue;
      const realDir = fs.realpathSync(dir);
      const relative = path.relative(workspace, realDir);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const files = fs.readdirSync(realDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        categories.add(path.basename(file, '.md'));
      }
    } catch {}
  }
  return Array.from(categories).sort();
}

function buildWhatToCheck(): string {
  return `## What to Check

**Plan alignment:**
- Does the implementation match what the PR description states?
- Are deviations justified improvements, or problematic departures?
- Is all intended functionality present?

**Bugs & correctness:**
- Logic errors, missing null checks, race conditions
- Improper error handling (swallowed errors, bare throws)
- Type safety issues (loose \`any\`, missing generics)
- Edge cases not handled (empty states, boundaries, timeouts)

**Security (CRITICAL):**
- PII exposure in logs, URLs, or client-side code
- Missing authentication or authorization checks
- Role-based access control (RBAC) gaps
- XSS vectors in user-facing content
- Secrets, tokens, or API keys hardcoded in source
- SQL injection via raw queries, missing rate limiting

**Dead code & YAGNI:**
- Unused state variables, imports, parameters, or functions
- Console.log / debug code left in
- Features implemented but never called
- Commented-out code blocks

**Architecture:**
- Clean separation of concerns?
- Sound design decisions for this codebase's scale?
- Integrates cleanly with surrounding code?
- Reasonable performance

**Test gaps (if tests exist in the PR):**
- Do tests verify real behavior or just mocks?
- Are edge cases covered?
- Are integration tests present where they matter?`;
}

function buildOutputFormat(): string {
  return `\`\`\`
{"type":"summary","text":"Brief overall assessment of the PR. 2-3 sentences."}
{"type":"verdict","ready":false,"reasoning":"1-2 sentence technical assessment.","autoFixable":true,"confidence":"high"}
{"type":"strength","file":"src/example.ts","line":10,"message":"What's well done and why."}
{"type":"issue","severity":"critical","file":"src/example.ts","line":42,"message":"What's wrong.","suggestion":"How to fix it.","inline":true}
\`\`\`

**Rules for the JSONL file:**
- You MUST write the JSONL content directly to the file \`.opencode/review-output.jsonl\`.
- After writing the file, you MUST verify that the JSONL file exists, is valid JSONL, and conforms strictly to the specified schema and rules (e.g. having exactly one summary, exactly one verdict, and correct fields).
- Write exactly ONE \`summary\` line and exactly ONE \`verdict\` line
- In the \`verdict\` line, you MUST also provide the following fields if \`ready\` is false:
  - \`autoFixable\` (boolean): Set to true only if ALL remaining critical and important issues are straightforward and safe for an automated agent to fix.
  - \`confidence\` (string): Set to "high", "medium", or "low". Set to "high" only if you are confident that the proposed fixes are correct and will not introduce regressions.
- Write zero or more \`strength\` and \`issue\` lines
- \`severity\` must be exactly "critical", "important", or "minor"
- Every issue MUST include file and line
- Suggestion is optional but recommended
- \`"inline": true\` ONLY if the line is in the PR diff
- If you find zero issues, write a verdict with \`"ready": true\`, \`"autoFixable": false\`, and \`"confidence": "high"\`
- Do NOT wrap in an array, do NOT add commas between lines`;
}

/**
 * Build a synthesis prompt to consolidate findings from parallel batch reviews.
 * Instructs the LLM to deduplicate, merge, and produce a coherent final result.
 *
 * @param inputs - Configuration inputs including project context.
 * @param findingsJsonl - JSONL text containing all batch findings to synthesize.
 * @returns The assembled synthesis prompt string.
 */
export function buildSynthesisPrompt(inputs: PromptBuilderInputs, findingsJsonl: string): string {
  const projectContext = inputs.projectContext || getDefaultProjectContext();

  return `You are a Senior Code Reviewer tasked with synthesizing batch review results into a final consolidated report.

## Project Context
${projectContext}

## Batch Review Findings
The following are findings from parallel batch reviews of different files in a pull request. Your task is to:

1. **Deduplicate** identical or overlapping findings across batches
2. **Consolidate** findings into a coherent overall summary and verdict
3. Ensure the output strictly conforms to the JSON Lines schema

### Batch Findings (JSONL):
${findingsJsonl}

## Instructions
- Review all findings and remove any duplicates (same file, line, and message)
- Merge related findings into single, well-written issues
- Write exactly ONE \`summary\` line with a brief overall assessment
- Write exactly ONE \`verdict\` line with the final decision
- Write zero or more \`strength\` and \`issue\` lines
- Maintain severity categorization (critical, important, minor)

## Output Format: JSON Lines
${buildOutputFormat()}`;
}

function getDefaultProjectContext(): string {
  return `Configure project context via the \`project_context\` input or a \`.opencode-reviewer.yml\` config file.

Default checks apply:
- TypeScript/JavaScript best practices
- Security (XSS, injection, secrets exposure)
- Error handling
- Dead code
- Architecture and separation of concerns`;
}
