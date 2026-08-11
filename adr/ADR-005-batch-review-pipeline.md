# ADR-005: Batch review pipeline with a single final post

- **Status:** Accepted
- **Date:** 2026-07-01
- **Deciders:** maintainers

## Context

Reviewing a large PR could review each file individually and post findings as it
goes (streaming per file) or batch files into groups, run concurrent sub-agent
reviews, synthesize, and post once. The key trade-off is latency-to-feedback vs.
quality and API efficiency.

Streaming per-file posts many small, low-context reviews and spams the PR with
partial findings. A batch pipeline gives each sub-agent a coherent set of files,
runs batches concurrently with CPU-aware parallelism, then a synthesis pass
merges and deduplicates findings before a single review post. Small PRs take a
fast single-pass path to avoid batching overhead.

## Decision

Use a batch review pipeline: split files into batches, run concurrent
sub-agent reviews, synthesize into one result, then post via a single API call.
Small PRs use a single-pass fast path.

Evidence in code:
- `lib/src/engine.ts:196-244` — Single-pass for small PRs (no batching overhead).
- `lib/src/engine.ts:246-322` — Concurrent batch execution with CPU-aware parallelism.
- `lib/src/engine.ts:330-357` — Synthesis pass consolidates batches into one JSONL.
- `lib/src/engine.ts:364-397` — Synthesis fallback merges raw batches on failure.
- `lib/src/engine.ts:695-793` — Meta-verification pass filters false positives.
- `action/src/review.ts:86-103` — Single API call for review posting.
- `lib/src/utils/github.ts:526-672` — Graceful degradation chain for posting.

## Consequences

Positive: higher-quality, deduplicated findings; fewer API round-trips; small
PRs stay fast. Negative: findings appear only after the full review completes
(mitigated by opt-in streaming comments); batches increase token usage vs. a
single-pass on medium PRs; synthesis adds a pass.

## Compliance

Review/audit orchestration must route through `ReviewEngine`'s batching +
synthesis. New posting paths should reuse `GitHubHelper.postReview`'s graceful
degradation chain. Streaming (when enabled) must post per-batch inline comments
via the engine's `onBatchComplete` hook and filter the final post to avoid
duplicates.
