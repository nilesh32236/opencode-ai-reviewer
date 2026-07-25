import type { ReviewIssue } from '../types/index.js';

/** Configuration inputs for building the verification prompt. */
export interface VerificationPromptInputs {
  /** Optional description of the project context and conventions. */
  projectContext?: string;
}

/**
 * Build a verification prompt to filter out false positives from initial review issues.
 * Instructs the LLM to verify each issue against the actual PR context and file contents,
 * dropping low-confidence or false-positive findings.
 *
 * @param inputs - Configuration inputs (project context).
 * @param prContext - Full PR context string.
 * @param issues - Initial list of review issues to verify.
 * @returns The assembled verification prompt string.
 */
export function buildVerificationPrompt(
  inputs: VerificationPromptInputs,
  prContext: string,
  issues: ReviewIssue[],
): string {
  const sections: string[] = [];

  sections.push('# Verification Pass: Quality Control & False Positive Removal');
  sections.push('');
  sections.push(
    'You are a Lead Code Reviewer performing a verification pass on proposed review findings.',
  );
  sections.push(
    'Your goal is to eliminate false positives, nitpicks, or misunderstood code before posting findings to the developer.',
  );
  sections.push('');

  sections.push('## PR Context');
  sections.push('');
  sections.push(prContext);
  sections.push('');

  if (inputs.projectContext) {
    sections.push('## Project Context');
    sections.push('');
    sections.push(inputs.projectContext);
    sections.push('');
  }

  sections.push('## Issues to Verify');
  sections.push('');
  sections.push('Verify each of the following proposed findings:');
  sections.push('');

  issues.forEach((issue, idx) => {
    sections.push(`### Issue #${idx}`);
    sections.push(`- **Severity:** ${issue.severity.toUpperCase()}`);
    sections.push(`- **File:** \`${issue.file}\` (Line ${issue.line})`);
    sections.push(`- **Message:** ${issue.message}`);
    if (issue.suggestion) {
      sections.push(`- **Proposed Fix:** \`${issue.suggestion}\``);
    }
    sections.push('');
  });

  sections.push('## Verification Instructions');
  sections.push('');
  sections.push('For EACH issue above:');
  sections.push('1. Use the `read` tool to inspect the exact file and surrounding lines.');
  sections.push(
    '2. Determine whether the issue is a **genuine, actionable defect** or a **false positive**.',
  );
  sections.push('3. Mark `valid: false` if:');
  sections.push('   - The code is already correct or handled upstream/downstream');
  sections.push('   - The issue is based on a misunderstanding of framework behavior');
  sections.push('   - The suggestion introduces a syntax error or regression');
  sections.push('   - The issue is overly pedantic or subjective without clear benefit');
  sections.push('4. Mark `valid: true` if the issue is accurate and worth fixing.');
  sections.push('');

  sections.push('## Output Format: JSON Lines');
  sections.push('');
  sections.push(
    'Write your verification decision for every issue directly to `.opencode/verification-output.jsonl`:',
  );
  sections.push('');
  sections.push('```');
  sections.push(
    '{"type":"verification","issueIndex":0,"valid":true,"reasoning":"Confirmed — null pointer possibility on L42."}',
  );
  sections.push(
    '{"type":"verification","issueIndex":1,"valid":false,"reasoning":"False positive — default value assigned on L38."}',
  );
  sections.push('```');
  sections.push('');
  sections.push('Write exactly ONE line per issue index.');

  return sections.join('\n');
}
