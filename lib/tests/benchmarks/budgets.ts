/**
 * Performance budgets enforced by the benchmark suite.
 * These are the single source of truth consumed by both the benchmark files
 * and the `reporter.ts` budget checker. Any regression that exceeds a budget
 * fails the CI benchmark job.
 */
export const BUDGETS = {
  /** Minimum throughput for parseJsonlString, in lines/second. */
  jsonlParseLinesPerSecond: 50_000,
  /** Minimum throughput for parseJsonlFile, in lines/second. */
  jsonlFileParseLinesPerSecond: 10_000,
  /** Maximum prompt construction time in milliseconds. */
  promptBuildMaxMs: 100,
  /** Maximum PR context building time in milliseconds. */
  contextBuildMaxMs: 200,
  /** Maximum heap delta in bytes when parsing a 2000-line JSONL payload. */
  heapDeltaMaxBytes: 5 * 1024 * 1024,
  /** Maximum per-batch orchestration overhead in milliseconds. */
  batchOverheadMaxMs: 50,
} as const;

/** Names of every enforceable budget. */
export type BudgetName = keyof typeof BUDGETS;
