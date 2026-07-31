import type { ReviewIssue, ReviewResult, Severity } from '../types/index.js';

/**
 * Get an emoji badge aligned with a finding's severity.
 * @param severity - Severity of the issue.
 * @returns Emoji string representing the severity.
 */
export function getSeverityBadge(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return '🔴';
    case 'important':
      return '🟠';
    case 'minor':
      return '🔵';
    default:
      return '⚪';
  }
}

/**
 * Format a confidence level as an explicit text label suffix.
 * @param confidence - Confidence level of the finding.
 * @returns A markdown suffix, or an empty string for high/undefined confidence.
 */
export function formatConfidenceLabel(confidence?: 'high' | 'medium' | 'low'): string {
  switch (confidence) {
    case 'low':
      return ' **[low confidence]**';
    case 'medium':
      return ' **[medium confidence]**';
    default:
      return '';
  }
}

/**
 * Format a single issue as a markdown bullet, sharing one canonical render
 * across review bodies and inline comments.
 * @param issue - Issue to render.
 * @returns A markdown bullet string.
 */
export function formatIssueBullet(issue: ReviewIssue): string {
  return `- ${getSeverityBadge(issue.severity)} **${issue.severity.toUpperCase()}:** \`${issue.file}:${issue.line}\` — ${issue.message}${formatConfidenceLabel(issue.confidence)}`;
}

/**
 * Build a markdown review body from a ReviewResult.
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
      lines.push(formatIssueBullet(i));
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
