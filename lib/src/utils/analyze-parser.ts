import type { GitHubHelper } from './github.js';

/**
 *
 */
export interface AnalysisPlanResult {
  /** Full raw markdown of the analysis plan. */
  planMarkdown: string;
  /** Whether the plan contains unanswered blocking questions. */
  hasBlockingQuestions: boolean;
  /** Array of blocking question strings extracted from the plan. */
  blockingQuestions: string[];
  /** Overall confidence level of the analysis. */
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';
}

/**
 * Parse an analysis plan markdown document to extract blocking questions and confidence level.
 *
 * @param markdown - Raw markdown output from engine.runAnalyze().
 * @returns Structured AnalysisPlanResult.
 */
export function parseAnalysisPlan(markdown: string): AnalysisPlanResult {
  const questionsSection =
    markdown
      .match(
        /(?:###|##)\s*(?:❓\s*)?(?:Blocking Questions|Questions \/ Decisions Needed[^\n]*)\n([\s\S]*?)(?=(?:###|##)\s*|$)/i,
      )?.[1]
      ?.trim() ?? '';

  const isNone =
    questionsSection.length === 0 ||
    /^\s*(?:none|ready to proceed|can proceed|no blocking questions)\b/i.test(questionsSection);

  const hasBlockingQuestions = !isNone;

  const blockingQuestions: string[] = [];
  if (hasBlockingQuestions) {
    const matches = questionsSection.matchAll(
      /-\s*(?:\*\*Q\d+:\*\*|\*\*Question \d+:\*\*|\d+\.|\*)\s*(.+)/g,
    );
    for (const match of matches) {
      const qText = match[1].trim();
      if (qText && !/^\s*(?:none|ready to proceed|can proceed)\b/i.test(qText)) {
        blockingQuestions.push(qText);
      }
    }
    if (blockingQuestions.length === 0 && questionsSection.length > 0) {
      blockingQuestions.push(questionsSection);
    }
  }

  const confidenceMatch = markdown.match(
    /(?:###|##)\s*Confidence Level\s*\n*\s*(HIGH|MEDIUM|LOW)/i,
  );
  const confidenceLevel = (confidenceMatch?.[1]?.toUpperCase() ?? 'MEDIUM') as
    | 'HIGH'
    | 'MEDIUM'
    | 'LOW';

  return {
    planMarkdown: markdown,
    hasBlockingQuestions,
    blockingQuestions,
    confidenceLevel,
  };
}

/**
 * Post blocking questions as a comment and set the analysis:needs-input label.
 * Shared across Action and App paths to avoid duplication.
 * @param gh - GitHub helper instance.
 * @param issueNumber - Issue number.
 * @param parsed - Parsed analysis plan result.
 */
export async function postBlockingQuestions(
  gh: GitHubHelper,
  issueNumber: number,
  parsed: AnalysisPlanResult,
): Promise<void> {
  const questionsBody = [
    '## ❓ Questions Before Proceeding',
    '',
    'I have analyzed this issue but need clarification before starting implementation.',
    'Please answer the following questions by replying to this comment:',
    '',
    ...parsed.blockingQuestions.map((q, i) => `**Q${i + 1}:** ${q}`),
    '',
    '---',
    '*Once these are answered, comment `/fix` to start the implementation.*',
  ].join('\n');

  await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-questions -->', questionsBody);
  await gh.ensureLabels(['analysis:needs-input']);
  await gh.addLabels(issueNumber, ['analysis:needs-input']);
}

/**
 * Post the "analysis:ready" label when there are no blocking questions.
 * Shared across Action and App paths.
 * @param gh - GitHub helper instance.
 * @param issueNumber - Issue number.
 */
export async function markAnalysisReady(gh: GitHubHelper, issueNumber: number): Promise<void> {
  await gh.ensureLabels(['analysis:ready']);
  await gh.addLabels(issueNumber, ['analysis:ready']);
}
