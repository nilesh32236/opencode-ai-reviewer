import type { LearningStore } from '../learning/store.js';
import type { ReviewMetricsReport, ReviewMetricsRow } from '../learning/types.js';
import { Logger } from '../utils/logger.js';

/**
 * MetricsService orchestrates aggregation, formatting, and report building
 * for review analytics. Consumes LearningStore to compute metrics on demand
 * and format them as structured Markdown reports.
 */
export class MetricsService {
  private store: LearningStore;
  private logger: Logger;

  /**
   * @param store - The LearningStore instance to query for metrics data.
   */
  constructor(store: LearningStore) {
    this.store = store;
    this.logger = new Logger('MetricsService');
  }

  /**
   * Build a structured metrics report for the given period.
   * Queries pre-computed review_metrics rows, falling back to
   * live aggregation if no pre-computed rows exist.
   *
   * @param options - Report options (period type, lookback days).
   * @param options.period - 'daily' or 'weekly' (default: 'daily').
   * @param options.sinceDays - Number of days to look back (default: 30).
   * @returns A structured ReviewMetricsReport.
   */
  async getReport(
    options: {
      period?: 'daily' | 'weekly';
      sinceDays?: number;
    } = {},
  ): Promise<ReviewMetricsReport> {
    const period = options.period ?? 'daily';
    const sinceDays = options.sinceDays ?? 30;

    const [metricsRows, perPRStats, feedbackBreakdown, latencyStats, severityDist, telemetryStats] =
      await Promise.all([
        this.store.getMetrics(period, 10),
        this.store.getPerPRStats(sinceDays),
        this.store.getFeedbackBreakdown(sinceDays),
        this.store.getLatencyStats(sinceDays),
        this.store.getSeverityDistribution(sinceDays),
        this.store.getTelemetryStats(sinceDays),
      ]);

    const suppressionStats = await this.store.getSuppressionRuleStats();

    const latestRow = metricsRows[0];
    const periodEnd = new Date().toISOString();
    const periodStart = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

    const totalFeedback = feedbackBreakdown.totalFeedback;
    const fpRate =
      totalFeedback > 0
        ? (feedbackBreakdown.dismissedCount + feedbackBreakdown.disputedCount) / totalFeedback
        : 0;
    const tpRate = totalFeedback > 0 ? feedbackBreakdown.acceptedCount / totalFeedback : 0;
    const dismissalRate = totalFeedback > 0 ? feedbackBreakdown.dismissedCount / totalFeedback : 0;

    return {
      periodType: period,
      periodStart,
      periodEnd,
      overview: {
        totalPrs: perPRStats.totalPrs ?? latestRow?.total_prs ?? 0,
        totalFindings: perPRStats.totalFindings ?? latestRow?.total_findings ?? 0,
        avgFindingsPerPr: perPRStats.avgFindingsPerPr ?? latestRow?.avg_findings_per_pr ?? 0,
      },
      quality: {
        truePositiveRate: Math.round(tpRate * 10000) / 10000,
        falsePositiveRate: Math.round(fpRate * 10000) / 10000,
        dismissalRate: Math.round(dismissalRate * 10000) / 10000,
        accuracyScore: latestRow?.avg_accuracy_score ?? null,
        actionabilityScore: latestRow?.avg_actionability_score ?? null,
      },
      performance: {
        avgReviewDurationMs: latencyStats.avgLatencyMs ?? latestRow?.avg_review_duration_ms ?? 0,
        totalTokensUsed: telemetryStats.totalTokensUsed ?? latestRow?.total_tokens_used ?? 0,
        avgTokensPerReview:
          telemetryStats.avgTokensPerReview ?? latestRow?.avg_tokens_per_review ?? 0,
      },
      severityDistribution: severityDist,
      trends: metricsRows,
      suppressionStats,
    };
  }

  /**
   * Compute and persist an aggregation for the given period type.
   *
   * @param periodType - 'daily' or 'weekly'.
   */
  async computeAggregation(periodType: 'daily' | 'weekly'): Promise<void> {
    this.logger.info(`Computing ${periodType} metrics aggregation`);
    await this.store.aggregateMetrics(periodType);
    this.logger.info(`Completed ${periodType} metrics aggregation`);
  }

  /**
   * Format a ReviewMetricsReport as a structured Markdown string.
   *
   * @param report - The metrics report to format.
   * @returns A Markdown-formatted report string.
   */
  formatReport(report: ReviewMetricsReport): string {
    const lines: string[] = [];
    const periodLabel = report.periodType === 'daily' ? 'Daily' : 'Weekly';

    lines.push(`## ${periodLabel} Review Metrics`);
    lines.push('');
    lines.push(
      `**Period:** ${new Date(report.periodStart).toLocaleDateString()} — ${new Date(report.periodEnd).toLocaleDateString()}`,
    );
    lines.push('');

    lines.push('### Overview');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total PRs Reviewed | ${report.overview.totalPrs} |`);
    lines.push(`| Total Findings | ${report.overview.totalFindings} |`);
    lines.push(`| Avg Findings per PR | ${report.overview.avgFindingsPerPr.toFixed(2)} |`);
    lines.push('');

    lines.push('### Quality Breakdown');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    const tpPercent = (report.quality.truePositiveRate * 100).toFixed(1);
    const fpPercent = (report.quality.falsePositiveRate * 100).toFixed(1);
    const dismissPercent = (report.quality.dismissalRate * 100).toFixed(1);
    lines.push(`| True Positive Rate | ${tpPercent}% |`);
    lines.push(`| False Positive Rate | ${fpPercent}% |`);
    lines.push(`| Dismissal Rate | ${dismissPercent}% |`);
    if (report.quality.accuracyScore !== null) {
      lines.push(`| Avg Accuracy Score | ${(report.quality.accuracyScore * 100).toFixed(1)}% |`);
    }
    if (report.quality.actionabilityScore !== null) {
      lines.push(
        `| Avg Actionability Score | ${(report.quality.actionabilityScore * 100).toFixed(1)}% |`,
      );
    }
    lines.push('');

    lines.push('### Performance');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(
      `| Avg Review Duration | ${this.formatDuration(report.performance.avgReviewDurationMs)} |`,
    );
    lines.push(`| Total Tokens Used | ${report.performance.totalTokensUsed.toLocaleString()} |`);
    lines.push(`| Avg Tokens/Review | ${report.performance.avgTokensPerReview.toLocaleString()} |`);
    lines.push('');

    if (report.severityDistribution) {
      lines.push('### Findings by Severity');
      lines.push('| Severity | Count |');
      lines.push('|----------|-------|');
      lines.push(`| Critical | ${report.severityDistribution.critical} |`);
      lines.push(`| Important | ${report.severityDistribution.important} |`);
      lines.push(`| Minor | ${report.severityDistribution.minor} |`);
      lines.push(`| Unknown | ${report.severityDistribution.unknown} |`);
      lines.push('');
    }

    if (report.suppressionStats) {
      lines.push('### Suppression Rules');
      lines.push('| Metric | Value |');
      lines.push('|--------|-------|');
      lines.push(`| Active Rules | ${report.suppressionStats.totalActive} |`);
      lines.push(`| Expired Rules | ${report.suppressionStats.totalExpired} |`);
      lines.push(`| Total Rules | ${report.suppressionStats.totalRules} |`);
      lines.push(
        `| Suppression Rule Injections | ${report.suppressionStats.totalSuppressionHits} |`,
      );
      lines.push('');
    }

    if (report.trends && report.trends.length > 1) {
      lines.push('### Trends (Recent Periods)');
      lines.push('| Period | PRs | Findings | FP Rate | Accuracy |');
      lines.push('|--------|-----|----------|---------|----------|');
      for (const row of report.trends.slice(0, 10)) {
        const periodStr = new Date(row.period_start).toLocaleDateString();
        const fpPct =
          row.false_positive_rate !== null
            ? `${(row.false_positive_rate * 100).toFixed(1)}%`
            : 'N/A';
        const accPct =
          row.avg_accuracy_score !== null ? `${(row.avg_accuracy_score * 100).toFixed(1)}%` : 'N/A';
        lines.push(
          `| ${periodStr} | ${row.total_prs} | ${row.total_findings} | ${fpPct} | ${accPct} |`,
        );
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('_Generated by OpenCode AI Reviewer Metrics Service_');

    return lines.join('\n');
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
}
