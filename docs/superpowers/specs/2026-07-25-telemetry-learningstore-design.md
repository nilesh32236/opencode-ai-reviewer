# Design: Capture and Persist Token Usage & Execution Telemetry in LearningStore

**Issue:** [#116](https://github.com/nilesh32236/opencode-ai-reviewer/issues/116)
**Date:** 2026-07-25

## Problem

`runOpenCode` returns `{ success, output, durationMs }` but `durationMs` is ignored by `ReviewEngine`, and token consumption is never captured. Without these metrics, maintainers cannot monitor costs, performance trends, or latency degradation over time.

## Goal

Update `runOpenCode`, `LearningStore` schema, and `ReviewEngine` to track execution time and token usage, and expose a helper to generate execution telemetry summaries.

## Architecture

### 1. Schema Migration (`lib/src/learning/schema.ts`)

Add nullable columns via `ALTER TABLE` guards (idempotent, safe on existing DBs):

- `findings.duration_ms INTEGER`
- `findings.tokens_used INTEGER`
- `review_quality.duration_ms INTEGER`
- `review_quality.tokens_used INTEGER`

### 2. `runOpenCode` Token Capture (`lib/src/opencode.ts`)

**Current:** `stdio: 'inherit'` — output goes directly to terminal, nothing captured.

**Change:** Switch to piped `stdio` (`['pipe', 'pipe', 'pipe']`), manually forward stdout/stderr to `process.stdout`/`process.stderr` for CI visibility, and capture the full output stream for token parsing.

**Token parsing:** Scan captured output for common LLM token patterns:
- `tokens: N`
- `total_tokens: N`
- `usage: { total_tokens: N }`
- `Total tokens: N`

Fallback: `tokensUsed: 0` if no pattern matches (graceful degradation).

**Return type:** `{ success: boolean; output: string; durationMs: number; tokensUsed: number }`

### 3. Type Updates (`lib/src/types/index.ts`)

`LearningQuality` gains optional fields:
```ts
durationMs?: number;
tokensUsed?: number;
```

### 4. Repository Interface (`lib/src/learning/types.ts`)

- `recordQuality` accepts optional `durationMs` and `tokensUsed`
- `recordFinding` accepts optional `durationMs` and `tokensUsed`
- New method: `getTelemetryStats(sinceDays?: number): Promise<TelemetryStats>`

### 5. LearningStore (`lib/src/learning/store.ts`)

- `recordQuality` passes through new optional fields
- `recordFinding` passes through new optional fields
- New method: `getTelemetryStats(sinceDays?: number)` returning:
  ```ts
  interface TelemetryStats {
    avgDurationMs: number;
    totalReviews: number;
    totalTokensUsed: number;
    avgTokensPerReview: number;
  }
  ```

### 6. SQL Adapters (`lib/src/learning/db.ts`)

- `SqlAdapter.recordQuality` — include new columns when present
- `SqlAdapter.recordFinding` — include new columns when present
- `SqliteAdapter.recordQuality` — include new columns when present
- `SqliteAdapter.recordFinding` — include new columns when present
- `SqlAdapter.getTelemetryStats` — aggregate query on `review_quality`
- `SqliteAdapter.getTelemetryStats` — aggregate query on `review_quality`

### 7. JSON Database (`lib/src/learning/json-db.ts`)

- Update `FindingRow` and `ReviewQualityRow` interfaces with optional fields
- Update `recordFinding`, `recordQuality` to store new fields
- Add `getTelemetryStats` implementation
- `JsonDbAdapter` delegates to `JsonDatabase`

### 8. ReviewEngine Integration (`lib/src/engine.ts`)

After each `runOpenCode` call, pass `durationMs` and `tokensUsed` to `learningStore.recordQuality()` when recording quality metrics.

### 9. Action Post Summary (`action/src/post.ts`)

Add a GitHub Step Summary section printing:
- Average review duration
- Total reviews run
- Estimated token usage
- Average tokens per review

## Data Flow

```text
runOpenCode() → { durationMs, tokensUsed }
    ↓
ReviewEngine.reviewPR() → learningStore.recordQuality({ ..., durationMs, tokensUsed })
    ↓
LearningStore → SqlAdapter/SqliteAdapter/JsonDatabase → persisted
    ↓
getTelemetryStats() → aggregated metrics → GitHub Step Summary
```

## Error Handling

- Token parsing failures → `tokensUsed: 0` (silent fallback)
- Telemetry recording failures → logged as warning, not thrown (graceful degradation)
- `getTelemetryStats` on empty data → returns zeros

## Testing

- Verify SQLite migration applies cleanly on existing databases
- Run `pnpm test`
- Verify `pnpm build` succeeds
- Verify `pnpm lint` passes
