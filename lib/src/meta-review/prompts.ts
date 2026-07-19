export function buildMetaReviewPrompt(context: {
  reviewSummary: string;
  findingsCount: number;
  issuesCount: number;
  strengthsCount: number;
  hasVerdict: boolean;
  fileCount: number;
}): string {
  return `You are evaluating the quality of an AI code review. Assess the review based on:

1. **Actionability** — Are the findings specific? Do they include file paths, line numbers, and concrete suggestions?
2. **Coverage** — Were enough files reviewed given the PR size?
3. **Consistency** — Are similar issues treated similarly across files?
4. **Accuracy signals** — Are there any obvious false positives?

Review output to evaluate:
- Summary: ${context.reviewSummary.slice(0, 500)}
- Findings: ${context.findingsCount} total (${context.issuesCount} issues, ${context.strengthsCount} strengths)
- Verdict: ${context.hasVerdict ? 'Yes' : 'No'}
- Files changed: ${context.fileCount}

Output a JSON object with scores (0-100):
{
  "actionabilityScore": <number>,
  "coverageScore": <number>,
  "consistencyScore": <number>,
  "accuracyScore": <number>,
  "suggestions": ["<suggestion to improve>"]
}

Write this JSON object to the file \`.opencode/meta-review-output.jsonl\`.
After writing, verify the file exists and contains valid JSON.
Return ONLY the JSON object, no markdown fences.`;
}
