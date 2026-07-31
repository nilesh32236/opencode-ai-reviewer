import type { PRContext, ReviewIssue } from '../../src/types/index.js';

const SEVERITIES: Array<'critical' | 'important' | 'minor'> = ['critical', 'important', 'minor'];
const LINE_TYPES = ['summary', 'verdict', 'strength', 'issue'] as const;

/**
 * Generate a single valid JSONL finding line for a given index.
 * Cycles through summary/verdict/strength/issue shapes so the parser exercises
 * its full validation path.
 * @param index - Index used to vary the generated line content.
 * @returns A single valid JSONL line (without trailing newline).
 */
export function generateJsonlLine(index: number): string {
  const type = LINE_TYPES[index % LINE_TYPES.length];
  switch (type) {
    case 'summary':
      return JSON.stringify({ type, text: `Synthetic summary for line ${index}.` });
    case 'verdict':
      return JSON.stringify({
        type,
        ready: index % 2 === 0,
        reasoning: `Synthetic verdict reasoning ${index}.`,
        autoFixable: false,
        confidence: 'medium',
      });
    case 'strength':
      return JSON.stringify({
        type,
        file: `src/module-${index % 10}.ts`,
        line: (index % 50) + 1,
        message: `Synthetic strength message ${index}.`,
      });
    default:
      return JSON.stringify({
        type,
        severity: SEVERITIES[index % SEVERITIES.length],
        file: `src/module-${index % 10}.ts`,
        line: (index % 50) + 1,
        message: `Synthetic issue message ${index}.`,
        suggestion: `Synthetic suggestion ${index}.`,
        inline: true,
      });
  }
}

/**
 * Generate a valid JSONL string containing `lineCount` finding lines.
 * @param lineCount - Number of JSONL lines to generate.
 * @returns A newline-separated JSONL payload.
 */
export function generateJsonlFixture(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(generateJsonlLine(i));
  }
  return lines.join('\n');
}

/**
 * Generate a synthetic unified-diff patch of roughly 20 lines for one file.
 * @param fileIndex - Index of the file, used to vary patch content.
 * @returns A unified diff patch string.
 */
export function generateDiffPatch(fileIndex: number): string {
  const lines = [
    `diff --git a/src/module-${fileIndex}.ts b/src/module-${fileIndex}.ts`,
    'index 1234567..89abcde 100644',
    `--- a/src/module-${fileIndex}.ts`,
    `+++ b/src/module-${fileIndex}.ts`,
    '@@ -10,20 +10,20 @@',
  ];
  for (let i = 0; i < 15; i++) {
    if (i % 3 === 0) {
      lines.push(`-const oldValue${fileIndex}_${i} = legacyLookup(${i});`);
    } else if (i % 3 === 1) {
      lines.push(`+const newValue${fileIndex}_${i} = modernLookup(${i});`);
    } else {
      lines.push(`  const context${i} = interpolate(${fileIndex}, ${i});`);
    }
  }
  return lines.join('\n');
}

/**
 * Generate a synthetic PR context containing `fileCount` changed files.
 * @param fileCount - Number of changed files to include.
 * @returns A PRContext fixture.
 */
export function generatePRContextFixture(fileCount: number): PRContext {
  const changedFiles = Array.from({ length: fileCount }, (_, i) => ({
    path: `src/module-${i}.ts`,
    status: 'modified' as const,
    additions: 10,
    deletions: 5,
    patch: generateDiffPatch(i),
  }));
  return {
    number: 1234,
    title: `Synthetic PR with ${fileCount} changed files`,
    body: 'This is a synthetic pull request body used for performance benchmarking.',
    headRef: 'feature/benchmark',
    headSha: 'abcdef1234567890',
    baseRef: 'main',
    author: 'benchmark-bot[bot]',
    labels: fileCount > 25 ? ['large-pr'] : [],
    changedFiles,
  };
}

/**
 * Generate synthetic review issues for fix-prompt benchmarks.
 * @param count - Number of issues to generate.
 * @returns An array of ReviewIssue fixtures.
 */
export function generateIssues(count: number): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (let i = 0; i < count; i++) {
    issues.push({
      type: 'issue',
      severity: SEVERITIES[i % SEVERITIES.length],
      file: `src/module-${i % 10}.ts`,
      line: (i % 50) + 1,
      message: `Synthetic issue ${i}.`,
      suggestion: `Synthetic suggestion ${i}.`,
      inline: true,
    });
  }
  return issues;
}
