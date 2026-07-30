import type { ReviewResult } from '../types/index.js';

/**
 * Build a markdown review body from a ReviewResult.
 *
 * @param result - Review result to render.
 * @returns Formatted markdown string.
 */
export function buildReviewBody(result: ReviewResult): string {
  const lines: string[] = [];

  if (result.executiveSummary) {
    const es = result.executiveSummary;
    const riskEmoji = es.riskLevel === 'high' ? '🔴' : es.riskLevel === 'medium' ? '🟡' : '🟢';
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(`**Purpose:** ${es.purpose}`);
    lines.push('');
    lines.push(`**Risk:** ${riskEmoji} ${es.riskLevel.toUpperCase()} — ${es.riskRationale}`);
    if (es.breakingChanges.length > 0) {
      lines.push('');
      lines.push('**Breaking Changes:**');
      for (const bc of es.breakingChanges) {
        lines.push(`- ⚠️ ${bc}`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push(
    '## MR Review Summary',
    '',
    result.summary,
    '',
    `**Ready to merge?** ${result.verdict.ready}`,
    '',
    `**Reasoning:** ${result.verdict.reasoning}`,
    '',
  );

  if (result.strengths.length > 0) {
    lines.push('### Strengths');
    lines.push('');
    for (const s of result.strengths) {
      lines.push(`- **${s.file}:${s.line}** — ${s.message}`);
    }
    lines.push('');
  }

  if (result.issues.length > 0) {
    lines.push('### Issues');
    lines.push('');
    for (const i of result.issues) {
      const badge = getConfidenceBadge(i.confidence);
      lines.push(
        `- ${badge} **${i.severity.toUpperCase()}:** \`${i.file}:${i.line}\` — ${i.message}`,
      );
      if (i.suggestion) {
        lines.push(`  > 💡 **How to fix:** ${i.suggestion}`);
      }
      if (i.suggestionCode) {
        lines.push('<details><summary>Show suggested fix</summary>');
        lines.push('');
        lines.push('```suggestion');
        lines.push(i.suggestionCode.trim());
        lines.push('```');
        lines.push('</details>');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Get an emoji badge for a confidence level.
 *
 * @param confidence - Confidence level.
 * @returns Emoji string representing the confidence level.
 */
export function getConfidenceBadge(confidence?: 'high' | 'medium' | 'low'): string {
  switch (confidence) {
    case 'high':
      return '🔴';
    case 'medium':
      return '🟡';
    case 'low':
      return '⚪';
    default:
      return '⚪';
  }
}
