import type { ReviewIssue, ReviewResult, Severity, TokenUsage } from '../types/index.js';

/**
 * Compute a 0-5 merge-readiness score from a review result, modeled on
 * Greptile's confidence score. Weighted by severity counts (critical weighs
 * more than important/minor), the verdict, and whether the review was partial.
 *
 *   5 = production-ready     4 = minor polish  3 = address feedback first
 *   2 = significant bugs     0-1 = critical problems / unreviewed
 *
 * @param result - The review result to score.
 * @returns An integer 0-5.
 */
export function computeMergeScore(result: ReviewResult): number {
  if (!result || result.verdict.ready === false || result.skipped) return 0;
  const stats = result.stats ?? {
    total: 0,
    critical: 0,
    important: 0,
    minor: 0,
  };
  const critical = stats.critical ?? 0;
  const important = stats.important ?? 0;
  const minor = stats.minor ?? 0;

  // A partial review (failed batches/agents) was never fully verified, so it
  // can never be "merge-ready" — score it low regardless of what was parsed.
  if ((result.failedBatches ?? 0) > 0 || (result.failedAgents ?? 0) > 0) {
    return 1;
  }

  if (critical > 0) return 1;
  if (important > 0) {
    // Multiple important issues keep the score low; one important issue is a
    // "address before merge" signal.
    return important >= 2 ? 2 : 3;
  }
  if (minor > 0) return 4;
  return 5;
}

/**
 * Render a merge-readiness score as a short markdown line.
 * @param score - The 0-5 score.
 * @returns A markdown string like "**Merge-readiness:** 🟢 5/5".
 */
export function formatMergeScore(score: number): string {
  const badge =
    score >= 5 ? '🟢' : score >= 4 ? '🟢' : score >= 3 ? '🟡' : score >= 2 ? '🟠' : '🔴';
  return `${badge} ${score}/5`;
}

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
  }
}

/**
 * Format a duration in milliseconds as a human-readable seconds string.
 * @param durationMs - Duration in milliseconds.
 * @returns A seconds string (e.g. "12.3s").
 */
function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Build a markdown token usage summary section from accumulated telemetry.
 * Renders totals plus duration, and includes the prompt/completion breakdown
 * and estimated cost when available. Returns an empty string when nothing was
 * measured so callers never render a misleading zero-token table.
 * @param usage - Accumulated token usage data.
 * @returns Markdown string for the token usage section, or '' when empty.
 */
export function buildTokenUsageSection(usage: TokenUsage): string {
  if (usage.totalTokens === 0 && usage.estimatedCost === undefined) {
    return '';
  }
  const lines: string[] = [
    '---',
    '',
    '### Token Usage',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Tokens | ${usage.totalTokens.toLocaleString()} |`,
  ];
  if (usage.promptTokens !== undefined) {
    lines.push(`| Prompt Tokens | ${usage.promptTokens.toLocaleString()} |`);
  }
  if (usage.completionTokens !== undefined) {
    lines.push(`| Completion Tokens | ${usage.completionTokens.toLocaleString()} |`);
  }
  lines.push(`| Duration | ${formatDuration(usage.durationMs)} |`);
  if (usage.estimatedCost !== undefined) {
    lines.push(`| Estimated Cost | $${usage.estimatedCost.toFixed(4)} |`);
  }
  return lines.join('\n');
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

  if (result.failedBatches !== undefined && result.failedBatches > 0) {
    lines.push(
      `> ⚠️ **Partial review** — ${result.failedBatches} file batch(es) failed; findings may be missing.`,
    );
    lines.push('');
  }

  if (result.failedAgents !== undefined && result.failedAgents > 0) {
    lines.push(
      `> ⚠️ **Partial review** — ${result.failedAgents} agent(s) failed; findings may be missing.`,
    );
    lines.push('');
  }

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
    `**Merge-readiness:** ${formatMergeScore(computeMergeScore(result))}`,
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

  // Token usage / cost is deliberately NOT rendered here: it is surfaced once
  // via the dedicated post-step comment (action/src/post.ts), which is gated on
  // the saved state and is verbosity-aware. Rendering it here too would show
  // the same totals twice on the same PR.

  return lines.join('\n');
}
