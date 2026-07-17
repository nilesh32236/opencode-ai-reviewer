import { promises as fs } from 'fs';
import type { LearningStore } from '../learning/store.js';
import { runOpenCode } from '../opencode.js';
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { buildMetaReviewPrompt } from './prompts.js';

export class MetaReviewEngine {
  constructor(private store: LearningStore) {}

  async runMetaReview(context: {
    prNumber: number;
    reviewSummary: string;
    findingsCount: number;
    issuesCount: number;
    strengthsCount: number;
    hasVerdict: boolean;
    fileCount: number;
  }): Promise<{
    actionabilityScore: number;
    accuracyScore: number;
    coverageScore: number;
    consistencyScore: number;
    suggestions: string[];
  }> {
    let fpRate = 0;
    try {
      fpRate = await this.store.getFalsePositiveRate();
    } catch {
      console.warn('Failed to get false positive rate, defaulting to 0');
    }
    const prompt = buildMetaReviewPrompt(context);

    const metaRunResult = await runOpenCode(prompt, {
      model: 'opencode/deepseek-v4-flash-free',
    });
    if (!metaRunResult.success) {
      console.warn('OpenCode meta-review execution failed, using default scores');
      return {
        actionabilityScore: 70,
        accuracyScore: Math.max(0, 100 - fpRate * 100),
        coverageScore: 70,
        consistencyScore: 70,
        suggestions: ['Meta-review execution failed'],
      };
    }

    let result: Record<string, unknown> = {};
    try {
      const content = await fs.readFile('.opencode/meta-review-output.jsonl', 'utf-8');
      const parsed = JSON.parse(content.trim().split('\n').pop() || '{}');
      result = parsed;
    } catch {
      result = {
        actionabilityScore: 70,
        coverageScore: 70,
        consistencyScore: 70,
        accuracyScore: Math.max(0, 100 - fpRate * 100),
        suggestions: ['Unable to complete meta-review analysis'],
      };
    }

    const quality = {
      prNumber: context.prNumber,
      actionabilityScore: (result.actionabilityScore as number) || 70,
      accuracyScore: (result.accuracyScore as number) || Math.max(0, 100 - fpRate * 100),
      coverageScore: (result.coverageScore as number) || 70,
      consistencyScore: (result.consistencyScore as number) || 70,
    };

    try {
      await this.store.recordQuality(quality);
    } catch {
      console.warn('Failed to record quality scores');
    }

    if (fpRate > 0.3) {
      try {
        await this.store.addPromptOverride(
          'general',
          `Note: Recent reviews had a ${Math.round(fpRate * 100)}% false positive rate. Be more conservative with issue severity.`,
          fpRate,
        );
      } catch {
        console.warn('Failed to add prompt override');
      }
    }

    return {
      ...quality,
      suggestions: (result.suggestions as string[]) || [],
    };
  }
}

export class MetaReviewSubscriber implements Subscriber {
  name = 'MetaReviewSubscriber';
  subscribedEvents = ['review.completed'];

  constructor(
    private engine: MetaReviewEngine,
    private store: LearningStore,
    private interval: number,
  ) {}

  async handle(event: GitHubEvent): Promise<void> {
    try {
      const shouldRun = await this.store.incrementAndCheckMetaReviewInterval(this.interval);
      if (!shouldRun) return;
    } catch {
      console.warn('Failed to check meta-review interval');
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
      await this.engine.runMetaReview({
        prNumber: payload.prNumber || event.prNumber || 0,
        reviewSummary: payload.reviewSummary || '',
        findingsCount: payload.findingsCount || 0,
        issuesCount: payload.issuesCount || 0,
        strengthsCount: payload.strengthsCount || 0,
        hasVerdict: payload.hasVerdict || false,
        fileCount: payload.fileCount || 0,
      });
    } catch (err) {
      console.error(
        `Meta-review failed for prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
