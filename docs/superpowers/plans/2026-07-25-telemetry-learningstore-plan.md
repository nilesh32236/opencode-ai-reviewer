# Telemetry in LearningStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture execution duration and token usage from OpenCode CLI runs, persist them in LearningStore, and expose telemetry summary helpers.

**Architecture:** Modify `runOpenCode` to capture stdout/stderr (while still streaming to CI) and parse token stats. Add nullable `duration_ms` and `tokens_used` columns to `findings` and `review_quality` tables via idempotent migrations. Update all repository adapters (SQLite, SQL abstract, JSON) to store and query these fields. Add `getTelemetryStats()` aggregation method. Wire telemetry through ReviewEngine and expose in action post summary.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), JSON fallback, GitHub Actions

## Global Constraints

- Strict TypeScript — no `any`
- ESM imports must end with `.js`
- All migrations must be idempotent (safe to run on existing DBs)
- Non-critical subsystems degrade gracefully (log warnings, don't throw)
- Follow existing patterns in the codebase
- Biome lint must pass (`pnpm lint`)
- `pnpm test` must pass
- `pnpm build` must succeed

---

### Task 1: Schema Migration — Add Telemetry Columns

**Files:**
- Modify: `lib/src/learning/schema.ts`

**Goal:** Add `duration_ms` and `tokens_used` columns to `findings` and `review_quality` tables via idempotent `ALTER TABLE` guards.

- [ ] **Step 1: Add ALTER TABLE migration guards**

In `lib/src/learning/schema.ts`, after the existing `review_quality` table creation (around line 74), add:

```typescript
    // Telemetry columns — idempotent migration guards
    await runner.exec(`ALTER TABLE findings ADD COLUMN duration_ms INTEGER`);
    await runner.exec(`ALTER TABLE findings ADD COLUMN tokens_used INTEGER`);
    await runner.exec(`ALTER TABLE review_quality ADD COLUMN duration_ms INTEGER`);
    await runner.exec(`ALTER TABLE review_quality ADD COLUMN tokens_used INTEGER`);
```

These are placed after the table creation blocks. SQLite's `ALTER TABLE ADD COLUMN` is safe to run even if the column already exists in newer SQLite versions, but to be fully idempotent across all versions, we wrap them in a try-catch. Replace the four lines above with:

```typescript
    // Telemetry columns — idempotent migration guards
    const telemetryColumns = [
      'ALTER TABLE findings ADD COLUMN duration_ms INTEGER',
      'ALTER TABLE findings ADD COLUMN tokens_used INTEGER',
      'ALTER TABLE review_quality ADD COLUMN duration_ms INTEGER',
      'ALTER TABLE review_quality ADD COLUMN tokens_used INTEGER',
    ];
    for (const sql of telemetryColumns) {
      try {
        await runner.exec(sql);
      } catch {
        // Column already exists — safe to ignore
      }
    }
```

- [ ] **Step 2: Verify migration compiles**

Run: `cd lib && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add lib/src/learning/schema.ts
git commit -m "feat: add telemetry columns to findings and review_quality tables"
```

---

### Task 2: Update Types — LearningQuality and TelemetryStats

**Files:**
- Modify: `lib/src/types/index.ts`
- Modify: `lib/src/learning/types.ts`

**Goal:** Add optional telemetry fields to `LearningQuality` type and define `TelemetryStats` interface. Update `LearningRepository` interface with `getTelemetryStats`.

- [ ] **Step 1: Update LearningQuality in types/index.ts**

In `lib/src/types/index.ts`, find the `LearningQuality` interface (around line 868) and add two optional fields:

```typescript
export interface LearningQuality {
  prNumber: number;
  actionabilityScore: number;
  accuracyScore: number;
  coverageScore: number;
  consistencyScore: number;
  durationMs?: number;
  tokensUsed?: number;
}
```

- [ ] **Step 2: Add TelemetryStats and update LearningRepository in learning/types.ts**

In `lib/src/learning/types.ts`, add after the existing interfaces:

```typescript
/** Aggregated telemetry statistics for review executions. */
export interface TelemetryStats {
  avgDurationMs: number;
  totalReviews: number;
  totalTokensUsed: number;
  avgTokensPerReview: number;
}
```

In the `LearningRepository` interface, update `recordQuality` signature and add `getTelemetryStats`:

```typescript
  recordQuality(quality: LearningQuality): Promise<void>;
  getTelemetryStats(sinceDays?: number): Promise<TelemetryStats>;
```

Also update `FindingInput` to include optional telemetry fields:

```typescript
export interface FindingInput {
  id?: string;
  prNumber: number;
  type: string;
  severity?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  durationMs?: number;
  tokensUsed?: number;
}
```

- [ ] **Step 3: Verify types compile**

Run: `cd lib && npx tsc --noEmit`
Expected: Errors about missing implementations (getTelemetryStats not implemented in adapters) — this is expected, will be fixed in later tasks.

- [ ] **Step 4: Commit**

```bash
git add lib/src/types/index.ts lib/src/learning/types.ts
git commit -m "feat: add TelemetryStats type and telemetry fields to LearningQuality and FindingInput"
```

---

### Task 3: Update runOpenCode — Capture Output and Parse Tokens

**Files:**
- Modify: `lib/src/opencode.ts`

**Goal:** Change `runOpenCode` from `stdio: 'inherit'` to piped mode, manually stream output to CI, capture full output for token parsing, and return `tokensUsed`.

- [ ] **Step 1: Update return type and spawn configuration**

In `lib/src/opencode.ts`, update the `runOpenCode` return type (line 288):

```typescript
): Promise<{ success: boolean; output: string; durationMs: number; tokensUsed: number }> {
```

Change the spawn configuration (around line 374) from `stdio: 'inherit'` to piped mode:

```typescript
  const childProcess = cp.spawn(binaryPath, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: safeEnv,
    detached: true,
  });
```

- [ ] **Step 2: Capture stdout/stderr and stream to CI**

Before the `childProcess.on('exit', ...)` handler, add output capture:

```typescript
  let capturedOutput = '';
  childProcess.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    capturedOutput += text;
    process.stdout.write(data);
  });
  childProcess.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    capturedOutput += text;
    process.stderr.write(data);
  });
```

- [ ] **Step 3: Parse token usage from captured output**

Add a helper function before `runOpenCode` (around line 276):

```typescript
/**
 * Parse token usage from OpenCode CLI output.
 * Looks for common LLM token patterns. Returns 0 if no pattern matches.
 */
function parseTokenUsage(output: string): number {
  const patterns = [
    /total_tokens["\s]*[:=]\s*(\d+)/i,
    /tokens["\s]*[:=]\s*(\d+)/i,
    /Total tokens["\s]*[:=]\s*(\d+)/i,
    /"total_tokens"\s*:\s*(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  return 0;
}
```

- [ ] **Step 4: Update return statements to include tokensUsed**

Find all return statements in `runOpenCode` and update them:

Line ~447 (success case):
```typescript
      return { success: true, output: capturedOutput, durationMs, tokensUsed: parseTokenUsage(capturedOutput) };
```

Line ~453 (warning case):
```typescript
      return { success: false, output: capturedOutput, durationMs, tokensUsed: parseTokenUsage(capturedOutput) };
```

Line ~457 (catch case):
```typescript
      return { success: false, output: capturedOutput, durationMs, tokensUsed: parseTokenUsage(capturedOutput) };
```

- [ ] **Step 5: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No new errors (existing getTelemetryStats errors from Task 2 still present)

- [ ] **Step 6: Commit**

```bash
git add lib/src/opencode.ts
git commit -m "feat: capture stdout/stderr and parse token usage in runOpenCode"
```

---

### Task 4: Update SQL Adapters — recordQuality, recordFinding, getTelemetryStats

**Files:**
- Modify: `lib/src/learning/db.ts`

**Goal:** Update `SqlAdapter` and `SqliteAdapter` to handle new telemetry columns and implement `getTelemetryStats`.

- [ ] **Step 1: Update SqlAdapter.recordFinding**

In `lib/src/learning/db.ts`, find `SqlAdapter.recordFinding` (around line 117) and update:

```typescript
  async recordFinding(finding: FindingInput): Promise<string> {
    const id = finding.id || generateId();
    await this.run(
      `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion, duration_ms, tokens_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        finding.prNumber,
        finding.type,
        finding.severity || null,
        finding.file || null,
        finding.line || null,
        finding.message,
        finding.suggestion || null,
        finding.durationMs || null,
        finding.tokensUsed || null,
      ],
    );
    return id;
  }
```

- [ ] **Step 2: Update SqlAdapter.recordFindings**

Update the batch insert (around line 140):

```typescript
  async recordFindings(findings: FindingInput[]): Promise<string[]> {
    if (findings.length === 0) return [];
    return this.transaction(async () => {
      const ids = findings.map(() => generateId());
      const placeholders = findings.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values = findings.flatMap((f, i) => [
        ids[i],
        f.prNumber,
        f.type,
        f.severity || null,
        f.file || null,
        f.line || null,
        f.message,
        f.suggestion || null,
        f.durationMs || null,
        f.tokensUsed || null,
      ]);
      await this.run(
        `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion, duration_ms, tokens_used) VALUES ${placeholders}`,
        values,
      );
      return ids;
    });
  }
```

- [ ] **Step 3: Update SqlAdapter.recordQuality**

Around line 403:

```typescript
  async recordQuality(quality: LearningQuality): Promise<void> {
    await this.run(
      `INSERT INTO review_quality (id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score, duration_ms, tokens_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        quality.prNumber,
        quality.actionabilityScore,
        quality.accuracyScore,
        quality.coverageScore,
        quality.consistencyScore,
        quality.durationMs || null,
        quality.tokensUsed || null,
      ],
    );
  }
```

- [ ] **Step 4: Add SqlAdapter.getTelemetryStats**

Add after `recordQuality` in `SqlAdapter`:

```typescript
  async getTelemetryStats(sinceDays?: number): Promise<{
    avgDurationMs: number;
    totalReviews: number;
    totalTokensUsed: number;
    avgTokensPerReview: number;
  }> {
    const dateFilter = sinceDays
      ? `AND created_at >= datetime('now', '-${sinceDays} days')`
      : '';
    const row = await this.get<{
      avg_duration: number | null;
      total_reviews: number;
      total_tokens: number | null;
    }>(
      `SELECT
        AVG(duration_ms) as avg_duration,
        COUNT(*) as total_reviews,
        SUM(tokens_used) as total_tokens
       FROM review_quality
       WHERE duration_ms IS NOT NULL ${dateFilter}`,
    );
    if (!row || row.total_reviews === 0) {
      return { avgDurationMs: 0, totalReviews: 0, totalTokensUsed: 0, avgTokensPerReview: 0 };
    }
    const avgDuration = row.avg_duration ?? 0;
    const totalTokens = row.total_tokens ?? 0;
    return {
      avgDurationMs: Math.round(avgDuration),
      totalReviews: row.total_reviews,
      totalTokensUsed: totalTokens,
      avgTokensPerReview: row.total_reviews > 0 ? Math.round(totalTokens / row.total_reviews) : 0,
    };
  }
```

- [ ] **Step 5: Update SqliteAdapter.recordFinding**

Around line 745:

```typescript
  async recordFinding(finding: FindingInput): Promise<string> {
    const id = finding.id || generateId();
    this.prepareStmt(
      `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion, duration_ms, tokens_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      finding.prNumber,
      finding.type,
      finding.severity || null,
      finding.file || null,
      finding.line || null,
      finding.message,
      finding.suggestion || null,
      finding.durationMs || null,
      finding.tokensUsed || null,
    );
    return id;
  }
```

- [ ] **Step 6: Update SqliteAdapter.recordFindings**

Around line 763:

```typescript
  async recordFindings(findings: FindingInput[]): Promise<string[]> {
    if (findings.length === 0) return [];
    return this.transaction(async () => {
      const ids = findings.map(() => generateId());
      const placeholders = findings.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values = findings.flatMap((f, i) => [
        ids[i],
        f.prNumber,
        f.type,
        f.severity || null,
        f.file || null,
        f.line || null,
        f.message,
        f.suggestion || null,
        f.durationMs || null,
        f.tokensUsed || null,
      ]);
      this.prepareStmt(
        `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion, duration_ms, tokens_used) VALUES ${placeholders}`,
      ).run(...values);
      return ids;
    });
  }
```

- [ ] **Step 7: Update SqliteAdapter.recordQuality**

Around line 986:

```typescript
  async recordQuality(quality: LearningQuality): Promise<void> {
    this.prepareStmt(
      `INSERT INTO review_quality (id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score, duration_ms, tokens_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      generateId(),
      quality.prNumber,
      quality.actionabilityScore,
      quality.accuracyScore,
      quality.coverageScore,
      quality.consistencyScore,
      quality.durationMs || null,
      quality.tokensUsed || null,
    );
  }
```

- [ ] **Step 8: Add SqliteAdapter.getTelemetryStats**

Add after `recordQuality` in `SqliteAdapter` (around line 998):

```typescript
  async getTelemetryStats(sinceDays?: number): Promise<{
    avgDurationMs: number;
    totalReviews: number;
    totalTokensUsed: number;
    avgTokensPerReview: number;
  }> {
    const dateFilter = sinceDays
      ? `AND created_at >= datetime('now', '-${sinceDays} days')`
      : '';
    const row = this.prepareStmt(
      `SELECT
        AVG(duration_ms) as avg_duration,
        COUNT(*) as total_reviews,
        SUM(tokens_used) as total_tokens
       FROM review_quality
       WHERE duration_ms IS NOT NULL ${dateFilter}`,
    ).get() as { avg_duration: number | null; total_reviews: number; total_tokens: number | null } | undefined;
    if (!row || row.total_reviews === 0) {
      return { avgDurationMs: 0, totalReviews: 0, totalTokensUsed: 0, avgTokensPerReview: 0 };
    }
    const avgDuration = row.avg_duration ?? 0;
    const totalTokens = row.total_tokens ?? 0;
    return {
      avgDurationMs: Math.round(avgDuration),
      totalReviews: row.total_reviews,
      totalTokensUsed: totalTokens,
      avgTokensPerReview: row.total_reviews > 0 ? Math.round(totalTokens / row.total_reviews) : 0,
    };
  }
```

- [ ] **Step 9: Update JsonDbAdapter.getTelemetryStats**

Add to `JsonDbAdapter` class (around line 1272, before `resetCounter`):

```typescript
  async getTelemetryStats(sinceDays?: number): Promise<{
    avgDurationMs: number;
    totalReviews: number;
    totalTokensUsed: number;
    avgTokensPerReview: number;
  }> {
    return this.db.getTelemetryStats(sinceDays);
  }
```

- [ ] **Step 10: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: Errors about missing `getTelemetryStats` in `JsonDatabase` — will be fixed in Task 5.

- [ ] **Step 11: Commit**

```bash
git add lib/src/learning/db.ts
git commit -m "feat: update SQL adapters for telemetry columns and add getTelemetryStats"
```

---

### Task 5: Update JSON Database — Telemetry Fields and getTelemetryStats

**Files:**
- Modify: `lib/src/learning/json-db.ts`

**Goal:** Update `FindingRow` and `ReviewQualityRow` interfaces, update methods, and add `getTelemetryStats`.

- [ ] **Step 1: Update FindingRow interface**

Around line 9:

```typescript
interface FindingRow {
  id: string;
  pr_number: number;
  type: string;
  severity?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  duration_ms?: number;
  tokens_used?: number;
  created_at: string;
}
```

- [ ] **Step 2: Update ReviewQualityRow interface**

Around line 30:

```typescript
interface ReviewQualityRow {
  id: string;
  pr_number: number;
  actionability_score: number;
  accuracy_score: number;
  coverage_score: number;
  consistency_score: number;
  duration_ms?: number;
  tokens_used?: number;
  created_at: string;
}
```

- [ ] **Step 3: Update recordFinding**

Around line 215:

```typescript
  async recordFinding(finding: FindingInput): Promise<string> {
    const id = finding.id || generateId();
    this.data.findings.push({
      id,
      pr_number: finding.prNumber,
      type: finding.type,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      message: finding.message,
      suggestion: finding.suggestion,
      duration_ms: finding.durationMs,
      tokens_used: finding.tokensUsed,
      created_at: new Date().toISOString(),
    });
    this.save();
    return id;
  }
```

- [ ] **Step 4: Update recordFindings**

Around line 232, add the two new fields inside the loop:

```typescript
      this.data.findings.push({
        id: ids[i],
        pr_number: f.prNumber,
        type: f.type,
        severity: f.severity,
        file: f.file,
        line: f.line,
        message: f.message,
        suggestion: f.suggestion,
        duration_ms: f.durationMs,
        tokens_used: f.tokensUsed,
        created_at: new Date().toISOString(),
      });
```

- [ ] **Step 5: Update recordQuality**

Around line 445:

```typescript
  async recordQuality(quality: LearningQuality): Promise<void> {
    this.data.review_quality.push({
      id: generateId(),
      pr_number: quality.prNumber,
      actionability_score: quality.actionabilityScore,
      accuracy_score: quality.accuracyScore,
      coverage_score: quality.coverageScore,
      consistency_score: quality.consistencyScore,
      duration_ms: quality.durationMs,
      tokens_used: quality.tokensUsed,
      created_at: new Date().toISOString(),
    });
    this.save();
  }
```

- [ ] **Step 6: Add getTelemetryStats**

Add before `resetCounter` (around line 571):

```typescript
  async getTelemetryStats(sinceDays?: number): Promise<{
    avgDurationMs: number;
    totalReviews: number;
    totalTokensUsed: number;
    avgTokensPerReview: number;
  }> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    const reviews = this.data.review_quality.filter(
      (r) => r.duration_ms != null && (!cutoff || new Date(r.created_at).getTime() >= cutoff),
    );
    if (reviews.length === 0) {
      return { avgDurationMs: 0, totalReviews: 0, totalTokensUsed: 0, avgTokensPerReview: 0 };
    }
    const totalDuration = reviews.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);
    const totalTokens = reviews.reduce((sum, r) => sum + (r.tokens_used ?? 0), 0);
    return {
      avgDurationMs: Math.round(totalDuration / reviews.length),
      totalReviews: reviews.length,
      totalTokensUsed: totalTokens,
      avgTokensPerReview: Math.round(totalTokens / reviews.length),
    };
  }
```

- [ ] **Step 7: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add lib/src/learning/json-db.ts
git commit -m "feat: update JSON database for telemetry fields and add getTelemetryStats"
```

---

### Task 6: Update LearningStore — Wire Telemetry Methods

**Files:**
- Modify: `lib/src/learning/store.ts`

**Goal:** Update `recordQuality` and `recordFinding` to pass telemetry fields, add `getTelemetryStats` method, and import `TelemetryStats`.

- [ ] **Step 1: Import TelemetryStats**

At the top of `lib/src/learning/store.ts`, update the import:

```typescript
import type { LearningFeedback, LearningQuality } from '../types/index.js';
import type { TelemetryStats } from './types.js';
```

- [ ] **Step 2: Add getTelemetryStats method**

Add after `recordQuality` (around line 284):

```typescript
  /**
   * Retrieve aggregated telemetry statistics for review executions.
   *
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns TelemetryStats with average duration, total reviews, and token usage.
   */
  async getTelemetryStats(sinceDays?: number): Promise<TelemetryStats> {
    const repo = await this.repoPromise;
    return repo.getTelemetryStats(sinceDays);
  }
```

- [ ] **Step 3: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add lib/src/learning/store.ts
git commit -m "feat: add getTelemetryStats to LearningStore"
```

---

### Task 7: Update ReviewEngine — Pass Telemetry to LearningStore

**Files:**
- Modify: `lib/src/engine.ts`

**Goal:** Pass `durationMs` and `tokensUsed` from `runOpenCode` results to `learningStore.recordQuality()` when recording quality metrics.

- [ ] **Step 1: Find where recordQuality is called**

Search for `recordQuality` in `lib/src/engine.ts`. It's called in the meta-review engine subscriber. The ReviewEngine itself doesn't directly call `recordQuality` — the `MetaReviewSubscriber` does. We need to pass telemetry through the review result or record it directly after `runOpenCode` calls.

Looking at the code, `runOpenCode` is called in multiple places in `engine.ts`. We need to record telemetry after each review pass. Add a private helper method and call it after `runOpenCode` in `reviewPR`.

- [ ] **Step 2: Add recordTelemetry helper**

Add a private method to `ReviewEngine` (around line 800):

```typescript
  private async recordTelemetry(
    prNumber: number,
    durationMs: number,
    tokensUsed: number,
  ): Promise<void> {
    if (!this.learningStore) return;
    try {
      await this.learningStore.recordQuality({
        prNumber,
        actionabilityScore: 0,
        accuracyScore: 0,
        coverageScore: 0,
        consistencyScore: 0,
        durationMs,
        tokensUsed,
      });
    } catch (err) {
      core.warning(
        `Failed to record telemetry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

- [ ] **Step 3: Call recordTelemetry after runOpenCode in reviewPR**

In `reviewPR`, after the single-batch `runOpenCode` call (around line 193), add:

```typescript
      await this.recordTelemetry(pr.number, runResult.durationMs, runResult.tokensUsed);
```

In the batch loop, after each batch's `runOpenCode` call (around line 256), add:

```typescript
          await this.recordTelemetry(pr.number, runResult.durationMs, runResult.tokensUsed);
```

After the synthesis `runOpenCode` call (around line 301), add:

```typescript
      await this.recordTelemetry(pr.number, synthesisResult.durationMs, synthesisResult.tokensUsed);
```

- [ ] **Step 4: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add lib/src/engine.ts
git commit -m "feat: pass telemetry from runOpenCode to LearningStore in ReviewEngine"
```

---

### Task 8: Export TelemetryStats from lib/index.ts

**Files:**
- Modify: `lib/src/index.ts`

**Goal:** Export `TelemetryStats` type so consumers (action package) can use it.

- [ ] **Step 1: Add export**

In `lib/src/index.ts`, find the learning store exports and add:

```typescript
export type { TelemetryStats } from './learning/types.js';
```

- [ ] **Step 2: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add lib/src/index.ts
git commit -m "feat: export TelemetryStats type from lib"
```

---

### Task 9: Add Telemetry Summary to Action Post

**Files:**
- Modify: `action/src/post.ts`

**Goal:** Add GitHub Step Summary section with telemetry stats.

- [ ] **Step 1: Import LearningStore and TelemetryStats**

At the top of `action/src/post.ts`:

```typescript
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import type { GitHubHelper, TelemetryStats } from '@opencode-pr-agent/lib';
import { LearningStore, validateRunChecksCommand } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { sanitize } from './utils.js';
```

- [ ] **Step 2: Add telemetry summary function**

Add before `runPost`:

```typescript
/**
 * Generate a markdown telemetry summary for GitHub Step Summary.
 */
function formatTelemetrySummary(stats: TelemetryStats): string {
  const lines: string[] = ['## Execution Telemetry', ''];
  lines.push(`- **Total Reviews:** ${stats.totalReviews}`);
  lines.push(`- **Average Duration:** ${(stats.avgDurationMs / 1000).toFixed(1)}s`);
  lines.push(`- **Total Tokens Used:** ${stats.totalTokensUsed.toLocaleString()}`);
  lines.push(`- **Avg Tokens/Review:** ${stats.avgTokensPerReview.toLocaleString()}`);
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 3: Add telemetry collection to runPost**

At the end of `runPost`, before the function ends:

```typescript
  // Post telemetry summary
  try {
    const learningEnabled = core.getInput('learning_enabled') !== 'false';
    if (learningEnabled) {
      const store = new LearningStore();
      const stats = await store.getTelemetryStats(30);
      if (stats.totalReviews > 0) {
        const summary = core.getInput('GITHUB_STEP_SUMMARY', { required: false }) || '';
        const telemetryMarkdown = formatTelemetrySummary(stats);
        await core.summary
          .addHeading('Execution Telemetry', 2)
          .addList([
            `Total Reviews: ${stats.totalReviews}`,
            `Average Duration: ${(stats.avgDurationMs / 1000).toFixed(1)}s`,
            `Total Tokens Used: ${stats.totalTokensUsed.toLocaleString()}`,
            `Avg Tokens/Review: ${stats.avgTokensPerReview.toLocaleString()}`,
          ])
          .write();
        core.info('Posted telemetry summary');
      }
      await store.close();
    }
  } catch (err) {
    core.warning(
      sanitize(
        `Failed to post telemetry summary: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
```

- [ ] **Step 4: Verify compilation**

Run: `cd action && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add action/src/post.ts
git commit -m "feat: add telemetry summary to action post-processing"
```

---

### Task 10: Build, Lint, and Test

**Files:**
- No file changes

**Goal:** Verify everything compiles, lints, and tests pass.

- [ ] **Step 1: Build all packages**

Run: `pnpm build`
Expected: All packages build successfully

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: No lint errors

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 5: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address build/lint/test issues"
```
