import { promises as fs } from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import type { LearningStore } from '../learning/store.js';
import { runOpenCode } from '../opencode.js';
import type { PatternDetector } from '../pattern-detector/engine.js';
import type { AgentConfig, GitHubEvent, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { buildMetaReviewPrompt } from './prompts.js';

/**
 * Evaluates the quality of AI code reviews by running a meta-review.
 * Scores actionability, accuracy, coverage, and consistency, and
 * optionally triggers pattern discovery and prompt overrides based
 * on false-positive rates.
 */
export class MetaReviewEngine {
  /**
   * @param store - Learning store for recording quality metrics and retrieving patterns
   * @param patternDetector - Optional pattern detector for discovering high-quality patterns after meta-review
   * @param config - Optional agent config for resolving the meta-review model
   */
  constructor(
    private store: LearningStore,
    private patternDetector?: PatternDetector,
    private config?: AgentConfig,
  ) {
    // Custom LLM providers are passed explicitly to runOpenCode below (rather
    // than a module global) so meta-review runs never clobber or observe the
    // provider config of a concurrently constructed ReviewEngine.
  }

  /**
   * Execute a meta-review: build the prompt, run the LLM, parse results,
   * record quality scores, and optionally discover patterns or add prompt
   * overrides based on false-positive rate.
   * @param context - Review context containing PR details and review summary
   * @param context.prNumber - Pull request number
   * @param context.reviewSummary - Summary text of the code review
   * @param context.findingsCount - Total number of findings in the review
   * @param context.issuesCount - Number of issues identified
   * @param context.strengthsCount - Number of strengths identified
   * @param context.hasVerdict - Whether the review includes a verdict
   * @param context.fileCount - Number of files changed in the PR
   * @param context.workingDir - Optional working directory for output file
   * @param signal - Optional abort signal to cancel execution
   * @returns Quality scores (actionability, accuracy, coverage, consistency) and suggestions
   */
  async runMetaReview(
    context: {
      prNumber: number;
      reviewSummary: string;
      findingsCount: number;
      issuesCount: number;
      strengthsCount: number;
      hasVerdict: boolean;
      fileCount: number;
      workingDir?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    actionabilityScore: number;
    accuracyScore: number;
    coverageScore: number;
    consistencyScore: number;
    suggestions: string[];
  }> {
    let fpRate = 0;
    // Distinguish "computed as 0" from "not computed at all": an unknown FP
    // rate must surface as an unknown accuracy score (-1) rather than a
    // misleading 100%.
    let fpRateComputed = false;
    try {
      fpRate = await this.store.getFalsePositiveRate();
      fpRateComputed = true;
    } catch {
      new Logger('MetaReviewEngine').warn('Failed to get false positive rate, defaulting to 0');
    }
    const prompt = buildMetaReviewPrompt(context);

    const metaRunResult = await runOpenCode(prompt, {
      model:
        this.config?.metaReviewModel ??
        this.config?.reviewModel ??
        'opencode/muse-spark-1.2-contributor-free',
      signal,
      llm: this.config?.llm,
    });
    if (!metaRunResult.success) {
      new Logger('MetaReviewEngine').warn(
        'OpenCode meta-review execution failed, using default scores',
      );
      return {
        actionabilityScore: 70,
        accuracyScore: fpRateComputed ? Math.max(0, 100 - fpRate * 100) : -1,
        coverageScore: 70,
        consistencyScore: 70,
        suggestions: ['Meta-review execution failed'],
      };
    }

    let result: Record<string, unknown> = {};
    try {
      const workingDir = context.workingDir || process.cwd();
      const content = await fs.readFile(
        path.join(workingDir, '.opencode', 'meta-review-output.jsonl'),
        'utf-8',
      );
      const parsed = JSON.parse(content.trim().split('\n').pop() || '{}');
      result = parsed;
    } catch {
      result = {
        actionabilityScore: 70,
        coverageScore: 70,
        consistencyScore: 70,
        accuracyScore: fpRateComputed ? Math.max(0, 100 - fpRate * 100) : -1,
        suggestions: ['Unable to complete meta-review analysis'],
      };
    }

    // Resolve a finite parsed score, preserving a legitimate 0 while falling
    // back for missing or non-finite (NaN/Infinity) values.
    const parsedAccuracy = Number(result.accuracyScore);
    const accuracyScore = Number.isFinite(parsedAccuracy)
      ? parsedAccuracy
      : fpRateComputed
        ? Math.max(0, 100 - fpRate * 100)
        : -1;

    const quality = {
      prNumber: context.prNumber,
      actionabilityScore: Number(result.actionabilityScore) || 70,
      accuracyScore,
      coverageScore: Number(result.coverageScore) || 70,
      consistencyScore: Number(result.consistencyScore) || 70,
      durationMs: metaRunResult.durationMs,
      tokensUsed: metaRunResult.tokensUsed,
    };

    try {
      await this.store.recordQuality(quality);
    } catch {
      new Logger('MetaReviewEngine').warn('Failed to record quality scores');
    }

    const avgScore =
      (quality.actionabilityScore +
        quality.accuracyScore +
        quality.coverageScore +
        quality.consistencyScore) /
      4;
    if (this.patternDetector && avgScore >= 70) {
      try {
        const patterns = await this.patternDetector.discover(3);
        // Batch pattern additions with a concurrency limit to avoid DB lock contention
        const concurrencyLimit = 3;
        for (let i = 0; i < patterns.length; i += concurrencyLimit) {
          const batch = patterns.slice(i, i + concurrencyLimit);
          await Promise.all(
            batch.map((p) =>
              this.store.addCustomRule(
                `Pattern: ${p.patternKey}\nMessages: ${p.messages.slice(0, 3).join(', ')}`,
                'auto',
              ),
            ),
          );
        }
        if (patterns.length > 0) {
          new Logger('MetaReviewEngine').info(
            `Meta-review: discovered ${patterns.length} high-quality pattern(s), added as pending rules`,
          );
        }
      } catch (err) {
        new Logger('MetaReviewEngine').warn('Failed to discover patterns after meta-review', err);
      }
    }

    if (fpRate > 0.3) {
      try {
        await this.store.addPromptOverride(
          'general',
          `Note: Recent reviews had a ${Math.round(fpRate * 100)}% false positive rate. Be more conservative with issue severity.`,
          fpRate,
        );
      } catch {
        new Logger('MetaReviewEngine').warn('Failed to add prompt override');
      }
    }

    return {
      ...quality,
      suggestions: (result.suggestions as string[]) || [],
    };
  }
}

/**
 * Subscriber that triggers a meta-review after each review completion.
 * Uses a configurable interval (every N reviews) to avoid running
 * meta-review too frequently.
 */
export class MetaReviewSubscriber implements Subscriber {
  /** Subscriber identifier */
  name = 'MetaReviewSubscriber';
  /** Events this subscriber listens to */
  subscribedEvents = ['review.completed'];

  /**
   * @param engine - The meta-review engine instance
   * @param store - Learning store for checking meta-review interval
   * @param interval - Number of reviews between meta-review runs
   */
  constructor(
    private engine: MetaReviewEngine,
    private store: LearningStore,
    private interval: number,
  ) {}

  /**
   * Handle the review.completed event — checks the meta-review interval
   * and triggers runMetaReview if needed.
   * @param event - GitHub event containing review payload data
   * @param signal - Optional abort signal to cancel execution
   */
  async handle(event: GitHubEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    try {
      const shouldRun = await this.store.incrementAndCheckMetaReviewInterval(this.interval);
      if (!shouldRun) return;
    } catch {
      new Logger('MetaReviewEngine').warn('Failed to check meta-review interval');
      return;
    }

    const payload = event.payload as {
      prNumber?: number;
      reviewSummary?: string;
      findingsCount?: number;
      issuesCount?: number;
      strengthsCount?: number;
      hasVerdict?: boolean;
      fileCount?: number;
    };

    try {
      await this.engine.runMetaReview(
        {
          prNumber: payload.prNumber || event.prNumber || 0,
          reviewSummary: payload.reviewSummary || '',
          findingsCount: payload.findingsCount || 0,
          issuesCount: payload.issuesCount || 0,
          strengthsCount: payload.strengthsCount || 0,
          hasVerdict: payload.hasVerdict || false,
          fileCount: payload.fileCount || 0,
        },
        signal,
      );
    } catch (err) {
      core.warning(
        `Meta-review failed for PR #${event.prNumber}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
