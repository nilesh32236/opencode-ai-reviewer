import type { LearningFeedback, LearningQuality } from '../types/index.js';

export interface FindingInput {
  id?: string;
  prNumber: number;
  type: string;
  severity?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface FeedbackInput {
  findingId: string;
  signalType: LearningFeedback['signalType'];
  signalValue: string;
  prNumber: number;
}

export interface PatternInput {
  patternKey: string;
  messageCluster: string[];
  frequency: number;
  fileTypes: string[];
}

export interface LearningRepository {
  close(): Promise<void>;
  exec(sql: string): Promise<void>;

  recordFinding(finding: FindingInput): Promise<string>;
  recordFindings(findings: FindingInput[]): Promise<string[]>;
  deleteFindings(prNumber: number): Promise<number>;
  getFindingsByType(type: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  getFindings(prNumber?: number, limit?: number): Promise<Array<Record<string, unknown>>>;
  recordFeedback(feedback: FeedbackInput): Promise<void>;
  recordFeedbackBatch(feedbacks: FeedbackInput[]): Promise<void>;
  getFindingMessages(limit?: number): Promise<Array<{ message: string; file?: string }>>;
  getFalsePositiveRate(): Promise<number>;
  getRelevantLessons(filePaths: string[]): Promise<string[]>;
  recordQuality(quality: LearningQuality): Promise<void>;
  getQualityTrends(limit?: number): Promise<Array<Record<string, unknown>>>;
  incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean>;
  recordPattern(pattern: PatternInput): Promise<void>;
  recordPatterns(patterns: PatternInput[]): Promise<void>;
  getPatterns(minFrequency?: number): Promise<Array<Record<string, unknown>>>;
  addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string>;
  getPendingRules(): Promise<Array<Record<string, unknown>>>;
  approveRule(ruleId: string): Promise<void>;
  declineRule(ruleId: string): Promise<void>;
  addPromptOverride(category: string, overrideText: string, fpRateBefore: number): Promise<void>;
  resetCounter(): Promise<void>;
}
