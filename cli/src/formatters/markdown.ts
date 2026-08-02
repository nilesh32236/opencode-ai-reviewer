import type { ReviewResult } from '@opencode-pr-agent/lib';
import { buildTokenUsageSection, formatIssueBullet } from '@opencode-pr-agent/lib';

/**
 * Format a review result as a GitHub-flavored markdown report.
 * @param result - Review result to render.
 * @returns A markdown string suitable for writing to a file.
 */
export function formatMarkdown(result: ReviewResult): string {
  const lines: string[] = [];

  if (result.failedBatches !== undefined && result.failedBatches > 0) {
    lines.push(
      `> ⚠️ **Partial review** — ${result.failedBatches} file batch(es) failed; findings may be missing.`,
    );
    lines.push('');
  }

  lines.push('# OpenCode AI Reviewer — Local Review');
  lines.push('');
  lines.push(`**Verdict:** ${result.verdict.ready ? '✅ **READY**' : '❌ **NOT READY**'}`);
  if (result.verdict.confidence) {
    lines.push(`**Confidence:** ${result.verdict.confidence}`);
  }
  if (result.verdict.reasoning) {
    lines.push('');
    lines.push(`**Reasoning:** ${result.verdict.reasoning}`);
  }
  lines.push('');

  if (result.summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(result.summary.trim());
    lines.push('');
  }

  if (result.issues.length > 0) {
    lines.push('## Issues');
    lines.push('');
    lines.push(
      `**Stats:** ${result.stats.total} total · ` +
        `${result.stats.critical} critical · ` +
        `${result.stats.important} important · ` +
        `${result.stats.minor} minor`,
    );
    lines.push('');
    for (const issue of result.issues) {
      lines.push(formatIssueBullet(issue));
      if (issue.suggestion) {
        lines.push(`  > 💡 **How to fix:** ${issue.suggestion}`);
      }
      if (issue.suggestionCode) {
        lines.push('<details><summary>Show suggested fix</summary>');
        lines.push('');
        lines.push('```suggestion');
        lines.push(issue.suggestionCode.trim());
        lines.push('```');
        lines.push('</details>');
      }
    }
    lines.push('');
  }

  if (result.strengths.length > 0) {
    lines.push('## Strengths');
    lines.push('');
    for (const strength of result.strengths) {
      const location = strength.file
        ? `\`${strength.file}${strength.line ? `:${strength.line}` : ''}\``
        : '';
      lines.push(`- ${location ? `**${location}** — ` : ''}${strength.message}`);
    }
    lines.push('');
  }

  if (result.usage) {
    const usageSection = buildTokenUsageSection(result.usage);
    if (usageSection) {
      lines.push(usageSection);
      lines.push('');
    }
  }

  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}
