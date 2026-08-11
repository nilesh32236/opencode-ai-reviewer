# Review Comments & Review Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix confirmed bugs in the review-comment/dedup/learning pipeline and add high-value review-quality improvements informed by deep competitor research (CodeRabbit, Qodo/PR-Agent, Greptile, Sourcery, Bito) and academic literature.

**Architecture:** The work splits into Phase 1 (correctness — bugs that cause lost/duplicated/misleading output) and Phase 2 (quality — features competitors converged on: persistent review comments, severity badges, rule ingestion). Phase 1 is mandatory; Phase 2 tasks are independent and additive.

**Tech Stack:** TypeScript, pnpm monorepo (`lib/`, `action/`, `app/`), Vitest, Biome, GitHub REST/GraphQL, Probot, better-sqlite3.

## Global Constraints

- ESM imports: all relative imports end with `.js`.
- No `any`; explicit interfaces.
- `lib` changes MUST be followed by `pnpm build` (action bundles are ncc-compiled into `action/lib/*.js`).
- Full gate before commit: `pnpm build && pnpm typecheck && pnpm test && pnpm lint`.
- `withRetry()` for external API calls; SQLite read-then-write in transactions; non-critical subsystems degrade gracefully.
- Tests first (red → green), per task.
- Dedup cache TTL: 5 minutes (`REVIEW_DEDUP_TTL_MS`), key `repo#pr#baseSha#headSha`.
- Docs + engine + bundles committed together per repo convention.

---

## Phase 1 — Correctness fixes

### Task 1: Dedup must not kill the autofix loop

**Files:**
- Modify: `lib/src/engine.ts:679-729` (`reviewPR`), `215-249` (dedup helpers)
- Test: `lib/tests/engine.test.ts` (dedup describe block)

**Problem:** The static `REVIEWED_CACHE` is shared across engine instances in a process. In the App flow, `handlePRReview` reviews PR at headSha H0 → `markReviewed`. Then `handleAutofixLoop` iteration 0 fetches the PR — still H0 (no fix pushed yet) — and `reviewPR` returns `emptyResult()` (dedup skip). Autofix treats empty as fatal and breaks the loop. The autofix feature never runs.

**Interfaces:**
- Consumes: `reviewPR(pr, iteration, ...)` — the `_iteration` param exists (unused for dedup).
- Produces: `reviewPR` gains a way to distinguish an intentional re-review (autofix iteration / manual `/review` / explicit previousFindings) from an accidental duplicate.

**Approach (chosen):** Thread a `forceReview?: boolean` option through `reviewPR`. The dedup cache check is skipped when `forceReview` is true; the in-flight check remains (two truly concurrent same-key runs should still share a pipeline). Callers:
- `app/src/handlers/autofix.ts` iteration loop → `forceReview: true` (it always wants a fresh review of the current head).
- `app/src/handlers/commands.ts` `/review` command → `forceReview: true` (user explicitly asked).
- Manual `/review` in `app/src/subscribers/review.ts` → pass through.
- `action/src/fix.ts` autofix loop → `forceReview: true`.
- Everything else unchanged.

- [ ] **Step 1: Write the failing test** — autofix-style: engine with real repo, `reviewPR(pr)` then a second `reviewPR` call that passes forceReview through the typed options object (`{ forceReview: true }` as the trailing options argument) → pipeline runs again (runOpenCode called twice), result is NOT empty.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement** — add a typed `ReviewOptions`-style options object (`{ forceReview?: boolean }`) as the final parameter of `reviewPR` (backward compatible). All call sites (`autofix.ts`, `commands.ts`, `fix.ts`, `subscribers/review.ts`) pass `{ forceReview: true }` through that object rather than positional `undefined` placeholder arguments, and `isAlreadyReviewed` is skipped when `options.forceReview` is set.

- [ ] **Step 4: Run tests to verify pass**

- [ ] **Step 5: Update callers** (`autofix.ts`, `commands.ts`, `fix.ts`) to pass `forceReview`.

- [ ] **Step 6: Commit**

### Task 2: `markReviewed` only on meaningful results; fix unhandled `.finally()` rejection

**Files:**
- Modify: `lib/src/engine.ts:228-231` (`setInFlightReview`), `713-714` (`markReviewed` call site)
- Test: `lib/tests/engine.test.ts`

**Problem (2 parts):**
1. `markReviewed` caches failed/fallback pipelines (emptyResult with `verdict.reasoning` = 'Review execution failed' / 'Failed to parse review output') for 5 min → a transient failure makes the next trigger a silent no-op.
2. `promise.finally(() => IN_FLIGHT_REVIEWS.delete(key))` creates a derived promise that is never caught → `unhandledRejection` when the pipeline rejects.

**Approach:**
- In `reviewPR`: after `await promise`, only call `markReviewed` via an explicit failure predicate `isMeaningfulReview(result)`. The predicate FIRST checks `REVIEW_FAILURE_SENTINELS` — `verdict.reasoning` ∈ {'Review execution failed', 'Failed to parse review output', 'All review agents failed', 'All review batches failed'} — and only then treats `summary`/`issues`/`strengths` content as meaningful, so a failed pipeline that still contains findings is never cached. Fallback or failed pipelines are never cached; a genuine clean review ('No issues found') still caches.
- In `setInFlightReview`: replace `.finally(...)` with a `.then(success, failure)` pair that deletes the entry in both branches and swallows the rejection (or attach a no-op `.catch`).

- [ ] **Step 1: Write failing tests** — (a) failed pipeline (runOpenCode failure) is NOT cached: second `reviewPR` re-runs pipeline; (b) no unhandled rejection: create an engine whose pipeline rejects, call `reviewPR`, assert no unhandledRejection fires (use `vi.spyOn(process, 'on')` or a rejection-tracking hook).

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

### Task 3: Distinguishable dedup-skip result + correct handling in App/Action

**Files:**
- Modify: `lib/src/engine.ts:689-692`, `lib/src/jsonl-parser.ts` (`emptyResult` or add `markerResult`)
- Modify: `app/src/handlers/pr-review.ts:253-262`, `action/src/review.ts:148-151`
- Test: `lib/tests/engine.test.ts`, `app/tests/handlers/pr-review.test.ts`, `action` tests

**Problem:** Dedup skip returns bare `emptyResult()` (summary '', reasoning ''). Downstream treats it as "no meaningful content": app posts a neutral check-run + leaves stale `<!-- review-in-progress -->` marker; action `core.setFailed`.

**Approach:** Give the skip a recognizable marker:
- Add to `ReviewResult` a `skipped?: { reason: 'dedup' | 'already-reviewed' }` optional field (backward compatible), or set `verdict.reasoning = 'Skipped: already reviewed'`.
- Define explicit terminal states for BOTH progress markers (`<!-- review-in-progress -->` and `<!-- review-stream-progress -->`) in the app and action flows:
  - successful review → mark completion ("✅ Review complete" / "Streaming complete");
  - skipped review → preserve the "Already reviewed at this commit" status;
  - failure → record a failed state ("❌ Review failed").
- App handler: update the markers at each terminal path. The `finally` block only releases in-progress state (engine cleanup) — it must never blanket-erase markers, or it would overwrite skipped/failed outcomes.
- Action handler: `postReview` cleanup flips the stream marker only after a successful post; skip/failure paths leave the terminal state intact.
- App handler: if `result.skipped`, treat as no-op success — update the in-progress marker to "✅ Already reviewed at this commit", skip the neutral check-run (or report the existing review's state), return normally.
- Action handler: if `result.skipped`, log info, `core.info` not `setFailed`.

- [ ] **Step 1: Write failing tests** — app handler with engine returning skipped result → no neutral check run, marker updated, no throw; action handler → no setFailed.

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

### Task 4: Streaming drop bug — only record streamed key on success; stable finding identity

**Files:**
- Modify: `action/src/review.ts:118-145`, `app/src/handlers/pr-review.ts:201-227`
- Test: `app/tests/handlers/pr-review.test.ts`, `action` tests

**Problem:** `postInlineComment` returns `null` on failure (422 out-of-diff, rate limit, network), but `streamedIssueKeys.add(...)` runs unconditionally. The final filter then drops the issue from the body → the finding is never posted anywhere. Also add pre-post dedup and only count successes.

**Approach:** Assign every finding a stable identity when it is produced — an occurrence index, or a key combining file, line, and stable finding content — so distinct findings on the same line stay independent while identical findings still deduplicate. Carry that identity through streaming deduplication (the inline-post loop and the final-result filter share the same key function), postReview commentId attribution, feedback/dismissal correlation, and autofix resolution. File, line, and message are used only as fallback values when ambiguity is explicitly detected (e.g. duplicate messages).

```ts
// Shared key: file + line + normalized finding content.
const key = streamedFindingKey(issue.file, issue.line, issue.message);
if (streamedIssueKeys.has(key)) continue;
const posted = await gh.postInlineComment(...);
if (posted) { streamedIssueKeys.add(key); streamedFindingCount++; }
```

- [ ] **Step 1: Write failing test** — app pr-review handler with streamed callback where `postInlineComment` returns null → issue still present in final body.

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement in both callers** — shared key function reused in the final-result filter; the app also captures `posted.commentId` keyed by the finding anchor for LearningStore correlation.

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

### Task 5: Handler-level posting idempotency (dedup above posting)

**Files:**
- Modify: `app/src/handlers/pr-review.ts`, `lib/src/utils/github.ts` (add `getBotReviews` / existing-review check), `lib/src/event-bus/router.ts` or a per-PR mutex in `app/src/subscribers/review.ts`
- Test: `app/tests/subscribers/review.test.ts`, `app/tests/handlers/pr-review.test.ts`

**Problem:** The engine in-flight dedup shares the *computed* result between two concurrent callers, but both callers then independently `postReview`, post marker comments, report check runs, and record learning rows. Result: two reviews posted for one pipeline run.

**Approach (belt-and-suspenders):**
1. Per-`(repo, prNumber)` in-flight promise map in the app subscriber layer so a second concurrent event for the same PR awaits the first handler invocation and then no-ops (single-flight).
2. Before `postReview`, check whether a bot review for the current `headSha` already exists (`gh` list reviews filtered by bot author + commit_id); if yes, skip posting and report check run as existing state.

- [ ] **Step 1: Write failing test** — two concurrent `handlePRReview` calls (or subscriber events) → only one `postReview` call on the mock adapter.

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement single-flight in subscriber + existing-review check in handler**

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

### Task 6: Feedback/dismissal correctness

**Files:**
- Modify: `lib/src/learning/feedback-subscriber.ts:237-322` (bot-author guard + line-only scope), `app/src/handlers/dismiss.ts:145-171` (non-inline dismissal records feedback), `app/src/handlers/pr-review.ts:405-435` (populate `commentId`), `lib/src/learning/feedback-subscriber.ts:10-11,262-272` (raise MAX_FINDINGS, debounce per thread)
- Test: `lib/tests/feedback-subscriber.test.ts`, `app/tests/handlers/dismiss.test.ts`

**Problems:**
1. Bot's own replies can self-trigger `disputed_comment` (no author filter in `handleCommentCreated`).
2. File-only scope marks ALL findings in the file as disputed (needs positive line).
3. `comment_id` correlation is dead code (never populated).
4. Non-inline (thread-level) dismissal records nothing.
5. MAX_FINDINGS=20 + per-PR 60s debounce drop legitimate disputes.

**Approach:**
1. Add `isBotUser`-style guard at top of `handleCommentCreated` (reuse heuristic from lines 181-188).
2. Require a positive line for keyword-scoped dispute matching; when absent, correlate by the replied-to parent comment message instead of whole-file.
3. Populate `commentId` in `recordFindings` from `postReview.commentIds` (map by file:line).
4. Thread-level dismissal: record a PR-scoped `dismissed` signal with the comment body.
5. Raise MAX_FINDINGS to 1000 (align with dismiss.ts), debounce keyed by `(prNumber, in_reply_to_id)`.

- [ ] **Step 1: Write failing tests** per sub-issue
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

### Task 7: All-batches-failed must not report ready:true (merge gate)

**Files:**
- Modify: `lib/src/engine.ts` (`buildFallbackResult` / synthesis-success branch, ~1249-1397)
- Test: `lib/tests/engine.test.ts` / `review-pipeline.integration.test.ts`

**Problem:** When every batch fails and synthesis also fails, `buildFallbackResult` returns `verdict.ready: true` + "No issues found". An un-reviewed PR is green-lit. Multi-agent path has `forceFailedVerdict`; legacy path doesn't.

**Approach:** In the legacy path, when `failedBatches === fileBatches.length`, force `ready:false` with `reasoning: 'All review batches failed'` (mirror multi-agent). Also guard the synthesis-success-on-empty-input branch.

- [ ] **Step 1: Write failing test** — all batches fail → verdict.ready false, reasoning mentions failure.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

### Task 8: `postOrUpdateComment` single-flight + pagination window

**Files:**
- Modify: `lib/src/utils/github.ts:882-918`, `lib/src/utils/gitlab-adapter.ts:724-760`
- Test: `lib/tests/github.test.ts`

**Problem:** TOCTOU read-then-write race → duplicate marker comments under concurrency; 5-page scan (500 comments) misses markers on busy PRs.

**Approach:** Module-level single-flight promise map keyed by `(apiUrl, repo, issueNumber, marker)` — provider identity is implicit per adapter module, while `apiUrl` + `repo` prevent cross-provider/cross-repository collisions. Concurrent callers with the same body share one upsert; a newer body for the same marker is coalesced into a follow-up upsert once the in-flight one settles, so the newest concurrent update is eventually applied. Each map entry is removed after its promise settles. Raise the scan window (walk all pages) for the marker lookup.

- [ ] **Step 1: Write failing test** — two concurrent `postOrUpdateComment` → exactly one POST.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

### Task 9: Batched postReview nodeId + commentId attribution

**Files:**
- Modify: `lib/src/utils/github.ts:647-790` (capture `node_id` in batched path; fix duplicate file:line misattribution)
- Test: `lib/tests/github.test.ts`, `lib/tests/post-review.integration.test.ts`

**Problem:** Batched path loses `nodeId` (needed for autofix minimize fallback); duplicate file:line uses `.find()` → misattributed commentId.

**Approach:** Extend the response comment type to include `nodeId`, push it in the batched path; disambiguate duplicate file:line by matching `(path, line, body)` or index alignment.

- [ ] **Step 1: Write failing test**
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

### Task 10: `resolveFixedComments` message-keyed

**Files:**
- Modify: `lib/src/utils/autofix-body.ts:195-243`
- Test: `lib/tests` (find existing autofix-body tests)

**Problem:** Resolution key is `file:line`; a line shift causes false resolution (moved-but-unfixed issue resolved) or false keep.

**Approach:** Correlate by message within the same file (normalized message match) as the primary key, falling back to file:line; only resolve when the previous issue's message is absent from the current review.

- [ ] **Step 1: Write failing test** — line-shifted issue not falsely resolved.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

### Task 11: Multi-agent path streams + stream-progress cleanup

**Files:**
- Modify: `lib/src/engine.ts` (`runMultiAgentReview`, `runAgentCategory`), `app/src/handlers/pr-review.ts` + `action/src/review.ts` (terminal progress state)
- Test: `lib/tests/engine.test.ts`

**Problems:**
1. Multi-agent path never calls `onBatchComplete` → streaming silently disabled.
2. `<!-- review-stream-progress -->` marker never cleaned up after final review.

**Approach:**
1. Thread `onBatchComplete` into `runMultiAgentReview`/`runAgentCategory`, invoke per completed agent category.
2. After successful `postReview`, update the progress marker to "✅ Review complete" (or add `deleteComment`).

- [ ] **Step 1: Write failing tests**
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

---

## Phase 2 — Review-quality improvements

### Task 12: Persistent review comment with per-commit history

**Files:**
- Modify: `lib/src/utils/github.ts` (add `publishPersistentComment` / find-by-header), `action/src/review.ts`, `app/src/handlers/pr-review.ts`
- Test: `lib/tests/github.test.ts`, app tests

**Approach (from PR-Agent `publish_persistent_comment_full` + Qodo):** On re-review, find the bot's existing summary comment by header prefix (`## AI Review`), update it in place; new findings marked **New**; resolved findings shown with strikethrough; per-commit `<details>` history (max 4). This is the dedup model the market converged on.

- [ ] **Step 1: Write failing test** (find-by-header + edit path)
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

### Task 13: Severity badges + merge-readiness score in summary

**Files:**
- Modify: `lib/src/utils/review-body.ts` (`computeMergeScore`, `formatMergeScore`, `getSeverityBadge`)
- Test: `lib/tests` for review-body

**Approach:** P0/P1/P2-style severity badges per finding (`getSeverityBadge`, mapped from severity), and a single deterministic 0-5 merge-readiness helper in `lib/src/utils/review-body.ts` (`computeMergeScore(result)`, rendered via `formatMergeScore`). Exact contract: inputs = ReviewResult stats (critical/important/minor counts), `verdict.ready`, `skipped`, and `failedBatches`/`failedAgents`; output is an integer 0–5 with no rounding — skipped or `ready: false` → 0; partial (any failed batches/agents) → 1; ≥1 critical → 1; ≥2 important → 2; exactly 1 important → 3; ≥1 minor → 4; clean → 5. `action/src/review.ts` and `app/src/handlers/pr-review.ts` render the shared helper's result (via `buildReviewBody`) rather than implementing separate scoring logic.

- [ ] **Step 1: Write failing test**
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

### Task 14: AGENTS.md/CLAUDE.md rule ingestion + commit context

**Files:**
- Modify: `lib/src/engine.ts` (`buildRepoRulesContext`, `buildCommitMessages`, and the prompt section where they are injected)
- Test: `lib/tests/engine.test.ts` (repo-rules + commit-context describe blocks)

**Approach:** Detect `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`RULES.md` in the repo root and add a compact `git log --oneline base..head` commit block (capped, e.g. `-30`) to the review prompt. Treat BOTH repository rules and commit messages as UNTRUSTED data: clearly delimit them in marked sections and preserve system-level instruction precedence — never label repo rules as authoritative or require the reviewer to enforce them. Prefer loading rule files from the trusted base revision (e.g. `git show base:AGENTS.md`) when available. Validate candidate files before reading (reject symlinks/non-regular files; confirm the resolved path stays inside the repo root) and retain strict size limits for both inputs (e.g. 16 KB per rules file, ≤30 commits).

- [ ] **Step 1: Write failing test**
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit**

---

## Phase 3 — Verify & deliver

### Task 15: Full gate + bundle rebuild + PR

- [ ] Run `pnpm build && pnpm typecheck && pnpm test && pnpm lint`
- [ ] Rebuild action bundles (part of `pnpm build`)
- [ ] Commit any remaining docs/bundle changes
- [ ] Push branch, create PR from `improve/review-comments-and-quality` → `main` with detailed description
