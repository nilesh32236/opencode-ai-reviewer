import type { ReviewIssue, ReviewResult, Severity } from '@opencode-pr-agent/lib';
import { getSeverityBadge } from '@opencode-pr-agent/lib';
import pc from 'picocolors';

// Gate ANSI color on a real terminal so redirected/piped output (e.g.
// `opencode-reviewer review > out.txt` or piping to jq/grep) stays clean.
const color = pc.createColors(process.stdout.isTTY === true);

/** Unicode badge used for a severity in terminal output.
 * @param severity - Severity of the issue.
 * @returns A colorized severity badge string.
 */
function severityBadge(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return color.red(color.bold('CRITICAL'));
    case 'important':
      return color.yellow(color.bold('IMPORTANT'));
    case 'minor':
      return color.cyan(color.bold('MINOR'));
  }
}

/** Colorize an individual issue line for terminal output.
 * @param issue - Issue to render.
 * @returns A colorized multi-line issue string.
 */
function formatIssueLine(issue: ReviewIssue): string {
  const location = color.dim(`${issue.file}:${issue.line}`);
  const confidence = issue.confidence ? color.dim(` [${issue.confidence}]`) : '';
  const lines: string[] = [
    `  ${getSeverityBadge(issue.severity)} ${severityBadge(issue.severity)} ${location} — ${issue.message}${confidence}`,
  ];
  if (issue.suggestion) {
    lines.push(`     ${color.dim('How to fix:')} ${issue.suggestion}`);
  }
  if (issue.suggestionCode) {
    for (const codeLine of issue.suggestionCode.trim().split('\n')) {
      lines.push(`     ${color.dim(codeLine)}`);
    }
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

  lines.push(color.bold('OpenCode AI Reviewer — Local Review'));
  lines.push(color.dim('────────────────────────────────────────'));
  lines.push('');

  const readyLabel = result.verdict.ready
    ? color.green(color.bold('READY'))
    : color.red(color.bold('NOT READY'));
  const confidence = result.verdict.confidence
    ? color.dim(` (${result.verdict.confidence} confidence)`)
    : '';
  lines.push(`${color.bold('Verdict:')} ${readyLabel}${confidence}`);
  if (result.verdict.reasoning) {
    lines.push(`${color.bold('Reasoning:')} ${result.verdict.reasoning}`);
  }
  lines.push('');

  if (result.executiveSummary) {
    const es = result.executiveSummary;
    const risk =
      es.riskLevel === 'high'
        ? color.red(color.bold('HIGH'))
        : es.riskLevel === 'medium'
          ? color.yellow(color.bold('MEDIUM'))
          : color.green(color.bold('LOW'));
    lines.push(color.bold('Executive Summary'));
    lines.push(`${color.dim('Purpose:')} ${es.purpose}`);
    lines.push(`${color.dim('Risk:')} ${risk} — ${es.riskRationale}`);
    for (const bc of es.breakingChanges) {
      lines.push(`${color.yellow('⚠')} ${color.dim('Breaking change:')} ${bc}`);
    }
    lines.push('');
  }

  if (result.summary) {
    lines.push(color.bold('Summary'));
    lines.push(result.summary.trim());
    lines.push('');
  }

  if (result.issues.length > 0) {
    lines.push(
      color.bold(
        `Issues (${result.issues.length}) — ` +
          `${color.red(String(result.stats.critical))} critical, ` +
          `${color.yellow(String(result.stats.important))} important, ` +
          `${color.cyan(String(result.stats.minor))} minor`,
      ),
    );
    lines.push('');
    for (const issue of result.issues) {
      lines.push(formatIssueLine(issue));
      lines.push('');
    }
  }

  if (result.strengths.length > 0) {
    lines.push(color.bold(`Strengths (${result.strengths.length})`));
    lines.push('');
    for (const strength of result.strengths) {
      const location = strength.file
        ? color.dim(` ${strength.file}${strength.line ? `:${strength.line}` : ''}`)
        : '';
      lines.push(`  ${color.green('✓')}${location} — ${strength.message}`);
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
    lines.push(color.dim(`Usage: ${parts.join(' · ')}`));
    lines.push('');
  }

  if (result.failedBatches !== undefined && result.failedBatches > 0) {
    lines.push(
      color.yellow(`⚠ ${result.failedBatches} file batch(es) failed — findings may be missing`),
    );
    lines.push('');
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
