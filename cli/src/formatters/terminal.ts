import type { ReviewIssue, ReviewResult, Severity } from '@opencode-pr-agent/lib';
import { getSeverityBadge } from '@opencode-pr-agent/lib';
import pc from 'picocolors';

/** Unicode badge used for a severity in terminal output.
 * @param severity - Severity of the issue.
 * @returns A colorized severity badge string.
 */
function severityBadge(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return pc.red(pc.bold('CRITICAL'));
    case 'important':
      return pc.yellow(pc.bold('IMPORTANT'));
    case 'minor':
      return pc.cyan(pc.bold('MINOR'));
  }
}

/** Colorize an individual issue line for terminal output.
 * @param issue - Issue to render.
 * @returns A colorized multi-line issue string.
 */
function formatIssueLine(issue: ReviewIssue): string {
  const location = pc.dim(`${issue.file}:${issue.line}`);
  const confidence = issue.confidence ? pc.dim(` [${issue.confidence}]`) : '';
  const lines: string[] = [
    `  ${getSeverityBadge(issue.severity)} ${severityBadge(issue.severity)} ${location} — ${issue.message}${confidence}`,
  ];
  if (issue.suggestion) {
    lines.push(`     ${pc.dim('How to fix:')} ${issue.suggestion}`);
  }
  return lines.join('\n');
}

/**
 * Format a review result for colorized terminal output.
 * @param result - Review result to render.
 * @returns A human-readable, ANSI-colorized report.
 */
export function formatTerminal(result: ReviewResult): string {
  const lines: string[] = [];

  lines.push(pc.bold('OpenCode AI Reviewer — Local Review'));
  lines.push(pc.dim('────────────────────────────────────────'));
  lines.push('');

  const readyLabel = result.verdict.ready
    ? pc.green(pc.bold('READY'))
    : pc.red(pc.bold('NOT READY'));
  const confidence = result.verdict.confidence
    ? pc.dim(` (${result.verdict.confidence} confidence)`)
    : '';
  lines.push(`${pc.bold('Verdict:')} ${readyLabel}${confidence}`);
  if (result.verdict.reasoning) {
    lines.push(`${pc.bold('Reasoning:')} ${result.verdict.reasoning}`);
  }
  lines.push('');

  if (result.summary) {
    lines.push(pc.bold('Summary'));
    lines.push(result.summary.trim());
    lines.push('');
  }

  if (result.issues.length > 0) {
    lines.push(
      pc.bold(
        `Issues (${result.issues.length}) — ` +
          `${pc.red(String(result.stats.critical))} critical, ` +
          `${pc.yellow(String(result.stats.important))} important, ` +
          `${pc.cyan(String(result.stats.minor))} minor`,
      ),
    );
    lines.push('');
    for (const issue of result.issues) {
      lines.push(formatIssueLine(issue));
      lines.push('');
    }
  }

  if (result.strengths.length > 0) {
    lines.push(pc.bold(`Strengths (${result.strengths.length})`));
    lines.push('');
    for (const strength of result.strengths) {
      const location = strength.file
        ? pc.dim(` ${strength.file}${strength.line ? `:${strength.line}` : ''}`)
        : '';
      lines.push(`  ${pc.green('✓')}${location} — ${strength.message}`);
    }
    lines.push('');
  }

  if (result.usage) {
    const usage = result.usage;
    const parts = [`duration ${(usage.durationMs / 1000).toFixed(1)}s`];
    if (usage.totalTokens > 0) {
      parts.unshift(`${usage.totalTokens} tokens`);
    }
    if (usage.estimatedCost !== undefined) {
      parts.push(`estimated $${usage.estimatedCost.toFixed(4)}`);
    }
    lines.push(pc.dim(`Usage: ${parts.join(' · ')}`));
    lines.push('');
  }

  if (result.failedBatches !== undefined && result.failedBatches > 0) {
    lines.push(
      pc.yellow(`⚠ ${result.failedBatches} file batch(es) failed — findings may be missing`),
    );
    lines.push('');
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
