/**
 * Performance budgets enforced by the benchmark suite.
 * These are the single source of truth consumed by both the benchmark files
 * and the `reporter.ts` budget checker. Any regression that exceeds a budget
 * fails the CI benchmark job.
 */
export const BUDGETS = {
  /** Minimum throughput for parseJsonlString, in lines/second. */
  jsonlParseLinesPerSecond: 200_000,
  /** Minimum throughput for parseJsonlFile, in lines/second. */
  jsonlFileParseLinesPerSecond: 50_000,
  /** Maximum prompt construction time in milliseconds. */
  promptBuildMaxMs: 1,
  /** Maximum PR context building time in milliseconds. */
  contextBuildMaxMs: 2,
  /** Maximum heap delta in bytes when parsing a 2000-line JSONL payload. */
  heapDeltaMaxBytes: 2 * 1024 * 1024,
  /** Maximum per-batch orchestration overhead in milliseconds. */
  batchOverheadMaxMs: 40,
  /**
   * Maximum end-to-end reviewPR latency (excluding the fixed inter-chunk
   * backoff, which is runner-topology-dependent) in milliseconds.
   */
  reviewLatencyMaxMs: 100,
} as const;

/** Names of every enforceable budget. */
export type BudgetName = keyof typeof BUDGETS;
