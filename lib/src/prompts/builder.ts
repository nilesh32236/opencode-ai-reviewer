import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import type {
  DocStyle,
  PreviousFindingIteration,
  ReviewBudgetMode,
  ReviewIssue,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { sanitizePromptInput } from '../utils/prompt-sanitizer.js';
import { getLanguagePrompts } from './language/index.js';
import type { SupportedLanguage } from './language/index.js';

const MAX_PROMPT_BYTES = 200 * 1024;
const PROMPT_TRUNCATION_MARKER = '... [prompt truncated at 200KB cap]';
// Cap for the codebase cross-file index section. It is the largest unbounded
// context input (built from the whole repo's symbol/import graph) and the
// most likely to push an assembled prompt over MAX_PROMPT_BYTES. Pre-capping it
// keeps the instruction tail — Output Format, Critical Rules, Additional
// Instructions — intact instead of relying on the whole-prompt tail truncation
// below, which would drop those framing instructions first.
const MAX_CODEBASE_INDEX_BYTES = 96 * 1024;
const logger = new Logger('prompt-builder');

/**
 * Truncate a string to a UTF-8 byte budget on a code-point boundary so
 * multibyte characters are never split (an orphan lead byte would otherwise
 * decode to U+FFFD). Returns the original string when it already fits.
 * @param text - The string to truncate.
 * @param maxBytes - Maximum number of UTF-8 bytes allowed.
 * @returns The truncated string, the original when it already fits, or an empty string when maxBytes is non-positive or not an integer.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !Number.isInteger(maxBytes)) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.toString('utf8', 0, end);
}

/**
 * Enforce the prompt byte cap. Both the cap check and the truncation operate on
 * UTF-8 encoded bytes (not UTF-16 code units), and truncation lands on a code
 * point boundary so multibyte characters are never split. The marker is
 * accounted for in the byte budget.
 * @param prompt - The assembled prompt string.
 * @returns The prompt, truncated at the byte cap with the truncation marker
 * appended when it exceeds the budget.
 */
export function capPromptLength(prompt: string): string {
  const markerBytes = Buffer.byteLength(PROMPT_TRUNCATION_MARKER, 'utf8') + 1;
  const totalBytes = Buffer.byteLength(prompt, 'utf8');
  if (totalBytes <= MAX_PROMPT_BYTES) return prompt;
  logger.warn(`Review prompt exceeds ${MAX_PROMPT_BYTES} byte cap, truncating tail`);
  const budgetBytes = MAX_PROMPT_BYTES - markerBytes;
  const prefix = truncateUtf8Bytes(prompt, budgetBytes);
  return `${prefix}\n${PROMPT_TRUNCATION_MARKER}`;
}

// Per-section byte budgets for the builders that assemble a fixed instruction
// tail around variable context. Each variable section is pre-capped so the
// aggregate stays within MAX_PROMPT_BYTES without ever tail-truncating the
// terminal instructions (Step-by-Step, CRITICAL RULES, Output Format, etc.).
const MAX_CONTEXT_SECTION_BYTES = 64 * 1024;
const MAX_ISSUES_SECTION_BYTES = 48 * 1024;
const MAX_PROJECT_CONTEXT_SECTION_BYTES = 32 * 1024;
const MAX_VERIFICATION_ERROR_BYTES = 16 * 1024;
const MAX_THREAD_HISTORY_BYTES = 48 * 1024;
const MAX_CODE_SNIPPET_BYTES = 32 * 1024;

/**
 * Bound a variable section to a byte budget, appending a truncation marker
 * when the section is cut so callers can tell the content was capped.
 * @param text - The section content to bound.
 * @param maxBytes - Maximum number of UTF-8 bytes allowed for the section.
 * @param label - Human-readable name used in the truncation marker.
 * @returns The section, truncated to the byte budget with a marker when capped.
 */
function boundSection(text: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const bounded = truncateUtf8Bytes(text, maxBytes);
  return `${bounded}\n... [${label} truncated at ${Math.round(maxBytes / 1024)}KB cap]`;
}

/** Input parameters for building a review prompt. */
export interface PromptBuilderInputs {
  reviewPromptFile?: string;
  reviewPromptExtra?: string;
  describePromptFile?: string;
  describePromptExtra?: string;
  maxFilesPerBatch?: number;
  projectContext?: string;
  runChecksAfterFix?: string;
  maxFixIterations?: number;
}

/** Options for configuring the review prompt. */
export interface ReviewPromptOptions {
  lessons?: string[];
  previousFindings?: PreviousFindingIteration[];
  falsePositiveRules?: string[];
  deltaContext?: string;
  previousBotComments?: Array<{
    file: string;
    line: number | null;
    body: string;
    commentId: number;
  }>;
  linterResults?: import('../types/index.js').LinterResult[];
  /** Budget review mode selected from PR diff size (injects a summary/split banner). */
  budgetMode?: ReviewBudgetMode;
  /** Total diff line count reported in the budget banner. */
  totalDiffLines?: number;
  /** Cross-file codebase context (exported symbols, imports, call graph) for the changed files. */
  codebaseIndexContext?: string;
  /** When true, the PR context includes per-file git blame annotations; the model is instructed to prioritize findings on lines introduced by this PR. */
  blameAware?: boolean;
  /** Detected programming languages from the changed files; injects per-language review guidance when present. */
  languages?: SupportedLanguage[];
  /** Structured test-gap analysis (modified symbols without test updates, new
   * untested exports, missing error-case tests). Injected as a dedicated
   * `## Test Gap Analysis` section when non-empty. */
  testGapContext?: string;
  /** Repo-defined review rules/coding conventions extracted from AGENTS.md,
   * CLAUDE.md, GEMINI.md, or a root rules file. Injected as a `## Repository
   * Review Rules` section so the reviewer enforces the team's own standards. */
  repoRulesContext?: string;
  /** Compact `git log --oneline base..head` commit list (author intent). */
  commitMessages?: string;
}

/**
 * Build the review prompt string from inputs and PR context.
 * @param inputs - Configuration inputs including optional custom prompt file, project context, etc.
 * @param prContext - The PR context string describing the pull request.
 * @param optionsOrLessons - Optional ReviewPromptOptions object, or a legacy
 * lessons array (shorthand for `{ lessons: [...] }`).
 * @returns The assembled review prompt string.
 *
 * Cross-file context can be supplied via `options.codebaseIndexContext` and is
 * injected as a dedicated `## Codebase Context (Cross-File Analysis)` section.
 */
export function buildReviewPrompt(
  inputs: PromptBuilderInputs,
  prContext: string,
  optionsOrLessons?: ReviewPromptOptions | string[],
): string {
  const options: ReviewPromptOptions = Array.isArray(optionsOrLessons)
    ? { lessons: optionsOrLessons }
    : (optionsOrLessons ?? {});

  const lessons = options.lessons;
  const prevFindings = options.previousFindings;
  const fpRules = options.falsePositiveRules;
  const deltaCtx = options.deltaContext;
  const prevBotComments = options.previousBotComments;
  const linterRes = options.linterResults;
  const effectiveBudgetMode = options.budgetMode;
  const effectiveTotalDiffLines = options.totalDiffLines;
  const codebaseIndexCtx = options.codebaseIndexContext;
  const blameAware = options.blameAware;
  const languages = options.languages;
  const testGapContext = options.testGapContext;
  const repoRulesContext = options.repoRulesContext;
  const commitMessages = options.commitMessages;

  if (inputs.reviewPromptFile) {
    const customPrompt = loadPromptFile(inputs.reviewPromptFile);
    if (customPrompt) {
      const sections: string[] = [customPrompt];
      sections.push('\n## PR & Issue Context');
      sections.push('');
      sections.push(sanitizePromptInput(prContext, { maxLength: 50_000 }));
      if (blameAware) {
        sections.push(buildBlameAwarenessSection());
      }
      if (languages && languages.length > 0) {
        const languageSections = getLanguagePrompts(languages);
        for (const section of languageSections) {
          sections.push('\n' + section);
        }
      }
      if (testGapContext) {
        sections.push('\n' + buildTestGapSection(testGapContext));
      }
      if (repoRulesContext) {
        sections.push('\n## Repository Review Rules');
        sections.push('');
        sections.push(repoRulesContext);
      }
      if (commitMessages) {
        sections.push('\n## Commits in this PR');
        sections.push('');
        sections.push(commitMessages);
      }
      if (inputs.reviewPromptExtra) {
        sections.push('\n## Additional Instructions');
        sections.push('');
        sections.push(inputs.reviewPromptExtra);
      }
      if (effectiveBudgetMode && effectiveBudgetMode !== 'full') {
        sections.push('\n' + buildBudgetBanner(effectiveBudgetMode, effectiveTotalDiffLines));
      }
      return capPromptLength(sections.join('\n'));
    }
  }

  const projectContext = inputs.projectContext || getDefaultProjectContext();
  const sections: string[] = [];

  sections.push(
    'You are a Senior Code Reviewer with deep expertise in software architecture, design patterns, and best practices. Review this pull request thoroughly.',
  );

  sections.push('\n## PR & Issue Context');
  sections.push('');
  sections.push(sanitizePromptInput(prContext, { maxLength: 50_000 }));

  if (deltaCtx) {
    sections.push('\n## Incremental Review (Delta Changes)');
    sections.push('');
    sections.push('This is a follow-up review for new commits pushed since the last review pass.');
    sections.push('Focus primarily on evaluating the new changes shown in this delta diff:');
    sections.push('');
    sections.push('```diff');
    let truncatedDelta = deltaCtx;
    if (deltaCtx.length > 5000) {
      const slice = deltaCtx.slice(0, 5000);
      const lastHunk = slice.lastIndexOf('\n@@');
      const lastNewline = slice.lastIndexOf('\n');
      const boundary = lastHunk > 0 ? lastHunk : lastNewline > 0 ? lastNewline : 5000;
      truncatedDelta = `${slice.slice(0, boundary)}\n... (truncated)`;
    }
    sections.push(truncatedDelta);
    sections.push('```');
  }

  if (testGapContext) {
    sections.push('\n' + buildTestGapSection(testGapContext));
  }

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
    '1. Inline diffs are provided for each changed file, truncated at the configured `maxLinesPerFile` limit.',
  );
  sections.push(
    "2. If a file's diff has a `[Patch truncated]` notice, use the `read` tool to inspect the full file.",
  );
  sections.push(
    '3. Use the `read` tool to view each changed file directly for additional context.',
  );
  sections.push('4. Review the provided file list thoroughly.');
  sections.push('5. If any single file exceeds 300 lines, read and review it separately.');

  if (effectiveBudgetMode && effectiveBudgetMode !== 'full') {
    sections.push('');
    sections.push(buildBudgetBanner(effectiveBudgetMode, effectiveTotalDiffLines));
  }

  sections.push('\n' + buildWhatToCheck());

  if (languages && languages.length > 0) {
    const languageSections = getLanguagePrompts(languages);
    for (const section of languageSections) {
      sections.push('\n' + section);
    }
  }

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

  sections.push('\n## Confidence Guide');
  sections.push('');
  sections.push(
    'Assign a confidence level to each issue based on how certain you are that it is a real problem:',
  );
  sections.push('');
  sections.push(
    '- **high**: Deterministic bugs (injection, XSS, null dereference, type errors, PII exposure) — these are clearly wrong and must be fixed',
  );
  sections.push(
    '- **medium**: Plausible issues (logic concerns, missing validation, style violations with known impact, maintainability concerns) — likely real but may have edge cases',
  );
  sections.push(
    '- **low**: Speculative suggestions (prefer X over Y, future-proofing, minor style preferences, optional optimizations) — nice to have but not actionable without more context',
  );
  sections.push('');
  sections.push(
    'Include the `"confidence"` field in every `issue` JSONL line. This helps developers prioritize which findings to address first.',
  );

  sections.push('\n## Output Format: JSON Lines');
  sections.push('');
  sections.push(buildOutputFormat());

  if (fpRules && fpRules.length > 0) {
    sections.push('\n## False Positive Suppression Rules');
    sections.push('');
    sections.push(
      'The following patterns were previously flagged but dismissed by human reviewers as intentional or not actual issues. DO NOT flag these patterns again:',
    );
    sections.push('');
    for (const rule of fpRules) {
      sections.push(`- ${rule}`);
    }
  }

  if (linterRes && linterRes.length > 0) {
    sections.push('\n## Linter Results');
    sections.push('');
    sections.push(
      'The following linters have been run against the changed files. Their output is provided for cross-reference. ' +
        'DO NOT flag issues that a linter already catches. Focus only on issues that linters cannot detect: ' +
        'architecture, design, logic, security, edge cases, and project-specific conventions.',
    );
    sections.push('');
    for (const result of linterRes) {
      if (result.findings.length === 0) continue;
      sections.push(`### ${result.tool}`);
      sections.push('');
      sections.push(`Command: \`${result.command}\``);
      sections.push('');
      const cap = result.findings.slice(0, 50);
      for (const finding of cap) {
        sections.push(
          `- \`${finding.file}:${finding.line}${finding.column ? `:${finding.column}` : ''}\` ${finding.ruleId ? `[${finding.ruleId}] ` : ''}${finding.message}`,
        );
      }
      if (result.findings.length > 50) {
        sections.push(`- ... and ${result.findings.length - 50} more`);
      }
      sections.push('');
    }
    sections.push(
      '**Remember:** Your value-add is catching issues that automated linters miss. Prioritize deep architectural and logic review over style or syntax issues that linters already handle.',
    );
  }

  if (repoRulesContext) {
    sections.push('\n## Repository Review Rules');
    sections.push('');
    sections.push(
      'The repository defines its own review rules and coding conventions (from AGENTS.md/CLAUDE.md/GEMINI.md or a rules file). Treat these as authoritative — enforce them, and prefer them over generic best practices where they conflict:',
    );
    sections.push('');
    const rulesCtx = truncateUtf8Bytes(repoRulesContext, 32_000);
    sections.push(rulesCtx);
    if (rulesCtx.length < repoRulesContext.length) {
      sections.push('');
      sections.push('... [repository rules truncated at 32KB cap]');
    }
  }

  if (commitMessages) {
    sections.push('\n## Commits in this PR');
    sections.push('');
    sections.push(
      "The commit messages below capture the author's intent. Use them to assess whether the changes actually implement what the commits claim, and to judge plan/code alignment:",
    );
    sections.push('');
    const commitCtx = truncateUtf8Bytes(commitMessages, 8_000);
    sections.push(commitCtx);
  }

  if (lessons && lessons.length > 0) {
    sections.push('\n## Historical Lessons');
    sections.push('');
    sections.push('The following patterns were detected in similar code in past reviews:');
    sections.push('');
    for (const lesson of lessons) {
      sections.push(`- ${lesson}`);
    }
  }

  if (codebaseIndexCtx && effectiveBudgetMode !== 'split') {
    sections.push('\n## Codebase Context (Cross-File Analysis)');
    sections.push('');
    sections.push(
      'The following cross-file relationships were detected. Use this context to detect import issues, duplicate symbols, missing exports, and broken callers across the codebase:',
    );
    sections.push('');
    const codebaseCtx = truncateUtf8Bytes(codebaseIndexCtx, MAX_CODEBASE_INDEX_BYTES);
    sections.push(codebaseCtx);
    if (codebaseCtx.length < codebaseIndexCtx.length) {
      sections.push('');
      sections.push('... [codebase context truncated at 96KB cap]');
    }
  }

  if (blameAware) {
    sections.push(buildBlameAwarenessSection());
  }

  if (prevFindings && prevFindings.length > 0) {
    sections.push('\n## Previous Review Iterations');
    sections.push('');
    sections.push(
      'This is not the first review of this PR. Issues were previously found and fixes were applied. Review ONLY the current state and report only issues that are STILL present.',
    );
    sections.push('');
    for (const pf of prevFindings) {
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

  if (prevBotComments && prevBotComments.length > 0) {
    sections.push('\n## Previously Reported Issues (Auto-Tracking)');
    sections.push('');
    sections.push(
      'The following issues were reported in previous reviews on this PR. Do NOT re-report issues that have been fixed:',
    );
    sections.push('');
    for (const comment of prevBotComments) {
      const location = comment.line != null ? `${comment.file}:${comment.line}` : comment.file;
      const snippet = sanitizePromptInput(comment.body.split('\n')[0].substring(0, 200), {
        maxLength: 50_000,
      });
      sections.push(`- **${location}** — ${snippet}`);
    }
    sections.push('');
    sections.push(
      '**IMPORTANT:** If an issue from the list above has been fixed, do NOT report it again. Only report NEW issues or issues that persist.',
    );
  }

  sections.push('\n## Critical Rules');
  sections.push('');
  sections.push('**DO:**');
  sections.push('- Reference specific file:line for every issue');
  sections.push('- Use the `read` tool to view file contents instead of relying on diff snippets');
  sections.push(
    '- When reading TypeScript source files, note that relative imports ending in `.js` (e.g. `./conversation.js`) map to `.ts` files on disk (`./conversation.ts`). Always use the `.ts` extension when opening source files',
  );
  sections.push('- Explain WHY each issue matters');
  sections.push('- Categorize by actual severity');
  sections.push('- Acknowledge strengths before issues');
  sections.push('- Give a clear verdict');
  if (blameAware) {
    sections.push(
      '- Prioritize findings on lines introduced in this PR (`[PR CHANGE]`); flag issues on pre-existing lines only when they are critical',
    );
  }
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

  return capPromptLength(sections.join('\n'));
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
  const fixIterations = inputs.maxFixIterations ?? 3;
  const safeContext = boundSection(
    sanitizePromptInput(context, { maxLength: 50_000 }),
    MAX_CONTEXT_SECTION_BYTES,
    'issue & thread context',
  );
  const safeVerificationError = verificationError
    ? boundSection(
        sanitizePromptInput(verificationError, { maxLength: 20_000 }),
        MAX_VERIFICATION_ERROR_BYTES,
        'verification errors',
      )
    : '';

  let issuesSection = '';
  if (issues && issues.length > 0) {
    issuesSection = `\n## Issues to Fix (Iteration ${iteration + 1}/${fixIterations})\n\n`;
    for (const issue of issues) {
      issuesSection += `- **${issue.severity.toUpperCase()}:** ${issue.file}:${issue.line} — ${issue.message}\n`;
      if (issue.suggestion) {
        issuesSection += `  > Suggestion: ${issue.suggestion}\n`;
      }
    }
  }
  issuesSection = boundSection(issuesSection, MAX_ISSUES_SECTION_BYTES, 'issues to fix');
  const boundedProjectContext = boundSection(
    projectContext,
    MAX_PROJECT_CONTEXT_SECTION_BYTES,
    'project context',
  );

  return `You are an Expert Software Engineer tasked with implementing a code fix for a GitHub Issue.

## Issue & Thread Context (Includes Title, Body, Comments, and Implementation Plan)

${safeContext}
${issuesSection}
## Project Context

${boundedProjectContext}
${verificationError ? `\n## Verification Errors from Previous Attempt\n\`\`\`\n${safeVerificationError}\n\`\`\`\n` : ''}
## Step-by-Step Execution Instructions

1. **Review the Context**:
   - Read the **Issue Title**, **Description**, and any **Implementation Plan** (\`<!-- issue-analysis-plan -->\`) in the thread.
   - Pay special attention to **Human Feedback / Maintainer Instructions** posted in the issue comments (e.g. choice between Option A vs Option B).

2. **Execute Code Changes**:
   - Open and inspect the affected files.
   - Apply minimal, clean, robust fixes following the approved plan and maintainer decisions.
   - After making changes, verify the fix addresses all listed issues.

3. **Verify**:
   - Run configured verification commands (e.g. lint/test) to ensure no regressions.

4. **Summarize Fix (REQUIRED)**:
   - Write a clear, comprehensive summary of your changes to \`.fix-summary.md\`.
   - This file becomes the pull request description — write it for a human reviewer, NOT as a copy of the issue.
   - Include sections:
     - **### What Was Done**: 1-3 sentences describing what changed and why.
     - **### Approach**: Technical explanation of your solution.
     - **### Key Changes**: Bullet points of files modified and the reason for each.

## CRITICAL RULES
- Do NOT run \`git commit\`, \`git push\`, or \`gh pr create\`.
- Do NOT modify files under \`.github/\` (workflow definitions, CI configs, release automation) or other repository-configuration files. Changing them requires special CI permissions your token does not have and will cause the push to be rejected. If an issue requires a workflow change, describe the required change in \`.fix-summary.md\` instead of editing the file.
- Strictly follow any explicit instructions provided by human maintainers in the comment thread.
- Keep fixes minimal and target only the issue described.
- If you cannot complete the fix, write the reason to \`.fix-stuck.md\` and stop.`;
}

/**
 * Build the documentation-generation prompt for the `/docs` command.
 * Instructs the LLM to identify changed functions, methods, and classes in a PR
 * that lack or have incomplete doc comments and to add JSDoc/TSDoc (or another
 * configured style) documentation for them without touching existing, correct
 * documentation.
 *
 * @param inputs - Configuration inputs.
 * @param context - Full context (PR description, comments, diffs, etc.).
 * @param docStyle - Doc comment style to fall back to when a file has no
 * existing convention ('auto' asks the model to infer per-file).
 * @returns The assembled docs prompt string.
 */
export function buildDocsPrompt(
  inputs: PromptBuilderInputs,
  context: string,
  docStyle: DocStyle = 'auto',
): string {
  const projectContext = inputs.projectContext || getDefaultProjectContext();
  const safeContext = boundSection(
    sanitizePromptInput(context, { maxLength: 50_000 }),
    MAX_CONTEXT_SECTION_BYTES,
    'PR & issue context',
  );
  const boundedProjectContext = boundSection(
    projectContext,
    MAX_PROJECT_CONTEXT_SECTION_BYTES,
    'project context',
  );

  const styleLine =
    docStyle === 'auto'
      ? "infer each file's existing convention (JSDoc, TSDoc, etc.) and fall back to JSDoc when a file has no existing doc comments"
      : `use the \`${docStyle}\` doc comment style for new comments (matching the repository's existing convention when one exists)`;

  return `You are an Expert Software Engineer specializing in API documentation. Your task is to add accurate documentation comments to the code changed in this pull request.

## PR & Issue Context

${safeContext}

## Project Context

${boundedProjectContext}

## Documentation Style

- Match each file's existing documentation convention where one is present.
- For new comments, ${styleLine}.
- Supported styles: JSDoc (\`/** ... */\`), TSDoc (\`/** ... */\` with \`@param\`/\`@returns\`/type tags), reStructuredText (\`#:\` docstrings), Doxygen, and NumPy-style docstrings.

## Step-by-Step Execution Instructions

1. **Read the PR context and diff**: Identify the files changed in this PR and which functions, methods, classes, exported types, and exported constants were introduced or modified.

2. **Open changed source files**: Use the \`read\` tool to inspect each changed source file. When reading TypeScript files, note that relative imports ending in \`.js\` (e.g. \`./conversation.js\`) map to \`.ts\` files on disk — always use the \`.ts\` extension when opening source files.

3. **Identify undocumented / under-documented code**: For each changed function, method, class, exported type, or exported constant, determine whether it already has a complete, accurate doc comment. Focus on changed code only — do not document pre-existing code that was not touched by this PR.

4. **Generate documentation comments** describing:
   - A one-line summary of what the symbol does.
   - Parameters (via \`@param\` or equivalent for the active style).
   - Return value (via \`@returns\` or equivalent).
   - Exceptions/errors that can be thrown.
   - Usage notes only when they add value.

5. **Preserve existing documentation**: Do NOT modify, rewrite, or remove existing doc comments that are already accurate. Only add missing doc comments or complete incomplete ones on changed code.

6. **Summarize (REQUIRED)**: Write a clear summary of what you documented to \`.docs-summary.md\`. Include:
   - **### What Was Done**: 1-3 sentences describing what documentation was added and why.
   - **### Approach**: Technical explanation of how you chose which code to document and which style to use.
   - **### Key Changes**: Bullet points of files documented and the reason for each.

## CRITICAL RULES
- Only add/complete documentation for code changed in this PR. Do not document untouched pre-existing code.
- Do NOT modify existing, correct doc comments.
- Do NOT change any code behavior, logic, or formatting unrelated to documentation.
- Do NOT run \`git commit\`, \`git push\`, or \`gh pr create\`.
- Write the summary file to \`.docs-summary.md\` in the current working directory.`;
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
 * Build a conversational reply prompt for answering a developer's follow-up
 * question on an AI review comment thread.
 *
 * @param filePath - The file path the original comment was on.
 * @param lineNumber - Optional line number the original comment referred to.
 * @param codeSnippet - The code snippet/diff context around the comment.
 * @param originalComment - The original AI review comment body.
 * @param threadHistory - Ordered array of prior replies in the thread (oldest first).
 * @param userQuestion - The developer's latest question/reply.
 * @returns The assembled reply prompt string.
 */
export function buildReplyPrompt(
  filePath: string,
  lineNumber: number | undefined,
  codeSnippet: string,
  originalComment: string,
  threadHistory: Array<{ author: string; body: string }>,
  userQuestion: string,
): string {
  const sections: string[] = [];

  sections.push(
    'You are a Senior Code Reviewer having a conversation with a developer about a review comment you made. Help them understand your reasoning and provide helpful clarification.',
  );
  sections.push('');

  sections.push('## Code Context');
  sections.push('');
  sections.push(
    `**File:** \`${filePath}\`${lineNumber !== undefined ? `, line ${lineNumber}` : ''}`,
  );
  sections.push('');
  sections.push('```');
  sections.push(
    boundSection(
      codeSnippet || '(No code snippet available)',
      MAX_CODE_SNIPPET_BYTES,
      'code snippet',
    ),
  );
  sections.push('```');
  sections.push('');

  sections.push('## Original Review Comment');
  sections.push('');
  sections.push(sanitizePromptInput(originalComment, { maxLength: 10_000 }));
  sections.push('');

  if (threadHistory.length > 1) {
    sections.push('## Thread History');
    sections.push('');
    let historyText = '';
    for (const entry of threadHistory.slice(0, -1)) {
      historyText += `**@${entry.author}:** ${sanitizePromptInput(entry.body, { maxLength: 10_000 })}\n`;
      historyText += '\n';
    }
    sections.push(boundSection(historyText, MAX_THREAD_HISTORY_BYTES, 'thread history'));
  }

  sections.push("## Developer's Question");
  sections.push('');
  sections.push(sanitizePromptInput(userQuestion, { maxLength: 10_000 }));
  sections.push('');

  sections.push('## Instructions');
  sections.push('');
  sections.push('- Answer concisely and directly — 2-5 sentences unless more detail is needed.');
  sections.push(
    '- Be helpful and constructive. The developer is asking for clarification, not challenging you.',
  );
  sections.push('- Reference specific code lines if relevant to your explanation.');
  sections.push(
    '- If you made an error in your original review, acknowledge it gracefully and correct it.',
  );
  sections.push(
    '- If the question is a simple acknowledgment (e.g., "Thanks", "Got it", "LGTM"), respond with a brief polite acknowledgment and move on.',
  );
  sections.push('- Do NOT suggest creating new issues, PRs, or running additional commands.');
  sections.push(
    '- Do NOT ask the developer to mark anything as resolved or take any GitHub actions.',
  );

  return capPromptLength(sections.join('\n'));
}

/**
 * Build the analyze prompt for analyzing a GitHub Issue against the codebase.
 * Instructs the LLM to investigate the issue, determine priority, and formulate
 * a step-by-step implementation plan before any code is modified.
 *
 * @param inputs - Configuration inputs including project context.
 * @param issueContext - The issue context string (title, body, labels, etc.).
 * @param projectContextStr - Optional project context override.
 * @returns The assembled analyze prompt string.
 */
export function buildAnalyzePrompt(
  inputs: PromptBuilderInputs,
  issueContext: string,
  projectContextStr?: string,
): string {
  const projContext = boundSection(
    projectContextStr || inputs.projectContext || getDefaultProjectContext(),
    MAX_PROJECT_CONTEXT_SECTION_BYTES,
    'project context',
  );
  const safeIssueContext = boundSection(
    sanitizePromptInput(issueContext, { maxLength: 50_000 }),
    MAX_CONTEXT_SECTION_BYTES,
    'issue & repository context',
  );

  return capPromptLength(`You are a Principal Software Architect and Lead Developer. Your task is to analyze a GitHub Issue against the codebase and formulate a precise, actionable Implementation Plan before any code is modified.

## Issue & Repository Context

${safeIssueContext}

## Project Context
${projContext}

## Instructions

1. **Investigate the Codebase**:
   - Use your available tools (like \`read\`, \`glob\`, \`grep\`) to inspect the files related to the issue title and description.
   - Trace function calls, entry points, imports, and test files to locate the exact cause or affected components.

2. **Evaluate Priority & Impact**:
   - Assign a priority: **Critical** (security vulnerability/data loss/blocking crash), **High** (major bug/broken core feature), **Medium** (minor bug/feature request), or **Low** (code quality/typo/cosmetic).

3. **Formulate an Implementation Plan**:
   - Break down the fix into concrete, minimal, step-by-step code modifications.
   - List specific file paths and line numbers/functions that need editing.

4. **Identify Options & Trade-offs (If applicable)**:
   - If there are multiple ways to fix the problem (e.g. quick bugfix vs. refactoring), outline the suggestions clearly as Options (Option A, Option B) so the maintainer can choose.

5. **Identify Blocking Questions**:
   - Only ask questions if the issue is genuinely ambiguous or has multiple valid approaches requiring human decision.
   - If the fix is clear-cut and obvious from inspecting the codebase, do NOT force questions. Write "None — ready to proceed with /fix".

## Output Format

Write your analysis in clean Markdown format to the file \`.opencode/analysis-plan.md\`.

Required Markdown Structure:

\`\`\`markdown
# 🔍 Issue Analysis & Implementation Plan

## 📊 Summary & Priority
- **Issue Title:** <Insert Issue Title>
- **Priority:** <Critical | High | Medium | Low>
- **Impact:** <Brief description of impact>
- **Root Cause / Problem:** <Technical explanation of why the issue exists>

## 📁 Affected Files
- \`path/to/file1.ts\` (Lines X-Y: functionName)
- \`path/to/file2.ts\`

## 🛠️ Step-by-Step Implementation Plan
1. **[file1.ts]**: Update \`functionName()\` to handle null inputs...
2. **[file2.ts]**: Pass down option to handler...
3. **[tests/file1.test.ts]**: Add unit test covering the edge case...

## 💡 Suggestions & Alternatives (Optional)
- **Option A (Recommended)**: Minimal fix in file1.ts.
- **Option B**: Refactor helper function across files.

### Blocking Questions
- **Q1:** <Question text or "None — implementation can proceed immediately.">

### Confidence Level
HIGH
\`\`\`

**CRITICAL RULES:**
- Do NOT run \`git commit\`, \`git push\`, or modify any source code files — this is a read-only analysis phase.
- Write the final markdown report to \`.opencode/analysis-plan.md\`.
- Ensure all file paths referenced actually exist in the codebase.`);
}

/**
 * Load a custom prompt file from the workspace directory.
}
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

/**
 * Build the budget-mode banner instructing the model how to adapt its review
 * depth for large diffs. Used by both the legacy review path and the
 * multi-agent path.
 * @param budgetMode - The active review budget mode ('summary' or 'split').
 * @param totalDiffLines - Approximate total changed lines, when known.
 * @returns The budget-mode banner string.
 */
export function buildBudgetBanner(budgetMode: ReviewBudgetMode, totalDiffLines?: number): string {
  const lineCount =
    totalDiffLines !== undefined ? `~${totalDiffLines} lines` : 'a very large number of lines';
  if (budgetMode === 'summary') {
    return `## Review Budget Mode: SUMMARY

This PR has ${lineCount} of changes. Focus your review on critical patterns only: security vulnerabilities, breaking changes, API misuse, and data exposure. You may report fewer issues than in full mode, but you MUST still emit structured \`summary\`, \`verdict\`, \`strength\`, and \`issue\` JSONL lines exactly as described in the Output Format section.`;
  }
  return `## Review Budget Mode: SPLIT RECOMMENDED

This PR has ${lineCount} of changes. Check ONLY for critical security issues, breaking changes, and API misuse. You may report fewer issues than in full mode, but you MUST still emit structured \`summary\`, \`verdict\`, \`strength\`, and \`issue\` JSONL lines exactly as described in the Output Format section. A split recommendation is added to the final review automatically.`;
}

/**
 * Build the Git Blame Awareness instruction section, injected into both the
 * standard and custom-prompt review paths when blame annotations are present.
 * @returns The markdown section (including leading newline).
 */
function buildBlameAwarenessSection(): string {
  return `## Git Blame Awareness
Most file diffs are followed by a \`### Git Blame Annotations\` block mapping line ranges to their last modifying commit, author, and date. Some files may lack annotations (e.g. files that exceed the per-file line cap or where git history is unavailable). Use these tags to judge whether a pattern is newly introduced by this PR or predates it:
- Lines tagged \`[PR CHANGE]\` were introduced or modified by this PR — flag issues here at their normal severity.
- Lines tagged \`pre-existing\` were last changed before this PR and were already reviewed/accepted in prior PRs — only report issues on them when they are critical (security, data loss, broken functionality). Deprioritize style, maintainability, and minor concerns on pre-existing lines.
- When deciding whether a pattern is newly introduced, rely on the blame tags rather than the diff position.

A line can be \`pre-existing\` even when it appears in the diff as context. Blame tags are the source of truth for PR scope.`;
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
- Are integration tests present where they matter?

**Test coverage gaps (when test-gap detection is enabled):**
- Functions or classes modified without corresponding test updates
- New exported symbols without any test coverage
- Error-handling paths (throw, reject) without error-case tests
- Integration points missing integration tests`;
}

/**
 * Build the `## Test Gap Analysis` prompt section injected when the
 * test-gap detector found gaps. The gap context contains changed file paths
 * from the PR and is sanitized like every other untrusted input before
 * interpolation so crafted paths cannot act as prompt instructions.
 * @param testGapContext - The detector's formatted markdown context string.
 * @returns The assembled prompt section.
 */
export function buildTestGapSection(testGapContext: string): string {
  const sanitizedContext = sanitizePromptInput(testGapContext, { maxLength: 50_000 });
  return `## Test Gap Analysis

The following source symbols appear to lack corresponding test coverage. Focus on these specific gaps during review and suggest concrete test cases for each:

${sanitizedContext}

For every gap, reference the exact file and symbol, and recommend a specific test case (success path, boundary case, and error case).`;
}

function buildOutputFormat(): string {
  return `\`\`\`
{"type":"executive_summary","purpose":"1-2 sentence description of what this PR does.","riskLevel":"low","riskRationale":"Why this risk level.","breakingChanges":[]}
{"type":"summary","text":"Brief overall assessment of the PR. 2-3 sentences."}
{"type":"verdict","ready":false,"reasoning":"1-2 sentence technical assessment.","autoFixable":true,"confidence":"high"}
{"type":"strength","file":"src/example.ts","line":10,"message":"What's well done and why."}
{"type":"issue","severity":"critical","file":"src/example.ts","line":42,"message":"What's wrong.","suggestion":"Add a null guard before iterating over data.user","suggestionCode":"const user = data?.user ?? null;","inline":true,"confidence":"high"}
\`\`\`

**Rules for the JSONL file:**
- You MUST write the JSONL content directly to the file \`review-output.jsonl\` in the current working directory.
- After writing the file, you MUST verify that the JSONL file exists, is valid JSONL, and conforms strictly to the specified schema and rules (e.g. having exactly one summary, exactly one verdict, and correct fields).
- Write exactly ONE \`executive_summary\` line with purpose, riskLevel ("low"/"medium"/"high"), riskRationale, and breakingChanges (array of strings)
- Write exactly ONE \`summary\` line and exactly ONE \`verdict\` line
- In the \`verdict\` line, you MUST also provide the following fields if \`ready\` is false:
  - \`autoFixable\` (boolean): Set to true only if ALL remaining critical and important issues are straightforward and safe for an automated agent to fix.
  - \`confidence\` (string): Set to "high", "medium", or "low". Set to "high" only if you are confident that the proposed fixes are correct and will not introduce regressions.
- Write zero or more \`strength\` and \`issue\` lines
- \`severity\` must be exactly "critical", "important", or "minor"
- Every issue MUST include file and line
- For EVERY issue raised, you MUST include a \`suggestion\` field explaining how to fix it (actionable, concise guidance).
- For \`critical\` and \`important\` issues, if the fix is a code change of ≤ 10 lines, ALSO provide a \`suggestionCode\` field containing the exact raw replacement code snippet. This renders as GitHub's 1-click "Apply suggestion" button.
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
- Write exactly ONE \`executive_summary\` line with purpose, riskLevel ("low"/"medium"/"high"), riskRationale, and breakingChanges (array of strings)
- Write exactly ONE \`summary\` line with a brief overall assessment
- Write exactly ONE \`verdict\` line with the final decision
- Write zero or more \`strength\` and \`issue\` lines
- Maintain severity categorization (critical, important, minor)

## Output Format: JSON Lines
${buildOutputFormat()}`;
}

/**
 * Build a multi-agent synthesis prompt that consolidates findings from
 * specialized review agents (security, performance, quality, logic) into a
 * single coherent final review. Instructs the synthesis agent to deduplicate
 * overlapping findings across agents, prioritize by severity × confidence, and
 * preserve each issue's originating category for downstream filtering.
 *
 * Custom review instructions are honored consistently with the specialized
 * agents: a configured `reviewPromptFile` is loaded and prepended (mirroring
 * `buildReviewPrompt`), and `reviewPromptExtra` is appended as additional
 * instructions so a user's custom guidance applies to the consolidation pass as
 * well as the agents that produced the findings.
 *
 * @param inputs - Configuration inputs including project context and optional
 * custom review prompt file / extra instructions.
 * @param findingsJsonl - JSONL text of per-agent findings, where each `issue`
 * line carries an `agent` field identifying its originating specialized agent.
 * @returns The assembled multi-agent synthesis prompt string.
 */
export function buildMultiAgentSynthesisPrompt(
  inputs: PromptBuilderInputs,
  findingsJsonl: string,
): string {
  const projectContext = inputs.projectContext || getDefaultProjectContext();
  const sections: string[] = [];

  if (inputs.reviewPromptFile) {
    const customPrompt = loadPromptFile(inputs.reviewPromptFile);
    if (customPrompt) {
      sections.push(customPrompt);
      sections.push('');
    }
  }

  sections.push(`You are a Senior Code Reviewer tasked with synthesizing findings from specialized review agents into a final consolidated report.

## Project Context
${projectContext}

## Agent Review Findings
The following are findings from parallel specialized review agents (security, performance, code quality, and logic), each of which reviewed the same pull request with a single narrow focus. Your task is to:

1. **Deduplicate** identical or overlapping findings across agents (same file, line, and message, or the same root cause described from different angles)
2. **Prioritize** findings by severity × confidence (critical + high-confidence first, low-confidence minor overlaps can be dropped)
3. **Consolidate** findings into a coherent overall summary and verdict
4. Ensure the output strictly conforms to the JSON Lines schema

### Agent Findings (JSONL, each issue tagged with its originating "agent"):
${findingsJsonl}

## Instructions
- Review all findings and remove any duplicates (same file, line, and message)
- Merge related findings into single, well-written issues
- Prioritize: keep high-severity/high-confidence findings, collapse low-value overlaps
- Preserve each issue's originating agent via the \`category\` field on every \`issue\` line (e.g. "security", "performance", "quality", "logic")
- Write exactly ONE \`executive_summary\` line with purpose, riskLevel ("low"/"medium"/"high"), riskRationale, and breakingChanges (array of strings)
- Write exactly ONE \`summary\` line with a brief overall assessment
- Write exactly ONE \`verdict\` line with the final decision
- Write zero or more \`strength\` and \`issue\` lines
- Maintain severity categorization (critical, important, minor)

## Output Format: JSON Lines
${buildOutputFormat()}`);

  if (inputs.reviewPromptExtra) {
    sections.push('\n## Additional Instructions');
    sections.push('');
    sections.push(inputs.reviewPromptExtra);
  }

  return capPromptLength(sections.join('\n'));
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

/**
 * Build an explain prompt for the /explain command.
 * Instructs the LLM to produce a plain-language explanation of the PR changes,
 * including purpose, risk assessment, and architecture impact.
 *
 * @param inputs - Configuration inputs including project context.
 * @param prContext - The PR context string describing the pull request.
 * @returns The assembled explain prompt string.
 */
export function buildExplainPrompt(inputs: PromptBuilderInputs, prContext: string): string {
  const boundedProjectContext = boundSection(
    inputs.projectContext || getDefaultProjectContext(),
    MAX_PROJECT_CONTEXT_SECTION_BYTES,
    'project context',
  );
  const safePrContext = boundSection(
    sanitizePromptInput(prContext, { maxLength: 50_000 }),
    MAX_CONTEXT_SECTION_BYTES,
    'PR & issue context',
  );

  return capPromptLength(`You are a Senior Software Engineer explaining a pull request to a team.

## PR & Issue Context

${safePrContext}

## Project Context
${boundedProjectContext}

## Instructions

Provide a clear, plain-English explanation of this PR for the development team. Structure your response as:

### 🎯 Purpose
What does this PR accomplish? (1-2 sentences)

### 📝 Changes Overview
Summarize the key changes made, grouped by component or feature area.
For each change, explain:
- **What** was changed
- **Why** it was changed
- Any **tradeoffs** or design decisions

### ⚠️ Risk Assessment
Rate the risk level (Low / Medium / High) and explain:
- What could break?
- Are there any breaking API changes?
- Database migration concerns?
- Performance implications?

### 🏗️ Architecture Impact
Does this PR affect the overall architecture? If so, explain how.

## Output Format
Write your response as a single markdown document directly to \`.opencode/explain-output.md\`.
Do NOT wrap in JSON. Be concise but thorough.`);
}

/**
 * Build a describe prompt for the `/describe` command.
 * Instructs the LLM to read the PR diff and commit messages and generate a
 * structured PR description including: a change overview grouped by
 * component/area, testing notes, a breaking-change flag with details,
 * suggested labels, and a suggested conventional-commit title.
 *
 * A custom prompt file (`describePromptFile`) replaces the built-in
 * instructions (mirroring the review prompt file behavior), with the PR
 * context appended; `describePromptExtra` is appended as additional
 * instructions in either case.
 *
 * @param inputs - Configuration inputs including project context and optional
 * custom describe prompt file / extra instructions.
 * @param prContext - The PR context string describing the pull request.
 * @returns The assembled describe prompt string.
 */
export function buildDescribePrompt(inputs: PromptBuilderInputs, prContext: string): string {
  const safePrContext = boundSection(
    sanitizePromptInput(prContext, { maxLength: 50_000 }),
    MAX_CONTEXT_SECTION_BYTES,
    'PR & issue context',
  );
  const boundedProjectContext = boundSection(
    inputs.projectContext || getDefaultProjectContext(),
    MAX_PROJECT_CONTEXT_SECTION_BYTES,
    'project context',
  );

  const sections: string[] = [];

  if (inputs.describePromptFile) {
    const customPrompt = loadPromptFile(inputs.describePromptFile);
    if (customPrompt) {
      const customSections: string[] = [customPrompt];
      customSections.push('\n## PR & Issue Context');
      customSections.push('');
      customSections.push(safePrContext);
      if (inputs.describePromptExtra) {
        customSections.push('\n## Additional Instructions');
        customSections.push('');
        customSections.push(inputs.describePromptExtra);
      }
      return capPromptLength(customSections.join('\n'));
    }
  }

  sections.push(
    'You are a Senior Software Engineer writing a clear, human-readable pull request description.',
  );
  sections.push('');

  sections.push('## PR & Issue Context');
  sections.push('');
  sections.push(safePrContext);
  sections.push('');
  sections.push('## Project Context');
  sections.push('');
  sections.push(boundedProjectContext);
  sections.push('');

  sections.push(`## Instructions

Read the PR diff and commit messages above and generate a structured PR description:

1. **Change Overview**: Summarize the key changes grouped by component or feature area. State what was changed and why.
2. **Testing Notes**: Describe how this PR should be tested, including any automated tests added or updated and manual verification steps.
3. **Breaking Changes**: Flag whether the PR introduces breaking changes. If yes, list each one with a short migration note; if no, state "None".
4. **Suggested Labels**: Propose 2-5 concise GitHub labels that fit this PR (e.g. \`feature\`, \`bug\`, \`dependencies\`, \`tests\`).
5. **Suggested Conventional-commit Title**: Propose a single conventional-commit title for this PR (e.g. \`feat: add describe mode for PR summaries\`).

## Output Format
Write your response as a single markdown document directly to \`.opencode/describe-output.md\`.
Use this structure:

\`\`\`markdown
## Summary
<1-2 sentence overview>

## Changes
- **<component/area>**: <what changed and why>
- ...

## Testing
- <test guidance>

## Breaking Changes
- <"None" or list with migration notes>

## Suggested Labels
- \`label1\`, \`label2\`, ...

## Suggested Conventional-commit Title
\`<type(scope): subject>\`
\`\`\`

Do NOT wrap in JSON. Be concise but thorough.`);

  if (inputs.describePromptExtra) {
    sections.push('\n## Additional Instructions');
    sections.push('');
    sections.push(inputs.describePromptExtra);
  }

  return capPromptLength(sections.join('\n'));
}
