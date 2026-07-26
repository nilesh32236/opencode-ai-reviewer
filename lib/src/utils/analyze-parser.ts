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
    /none|ready to proceed|can proceed|no blocking questions/i.test(questionsSection);

  const hasBlockingQuestions = !isNone;

  const blockingQuestions: string[] = [];
  if (hasBlockingQuestions) {
    const matches = questionsSection.matchAll(
      /-\s*(?:\*\*Q\d+:\*\*|\*\*Question \d+:\*\*|\d+\.|\*)\s*(.+)/g,
    );
    for (const match of matches) {
      const qText = match[1].trim();
      if (qText && !/none|ready to proceed|can proceed/i.test(qText)) {
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
