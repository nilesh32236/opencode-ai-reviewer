# Self-Improving AI Reviewer — Design Spec

## 1. Summary

Add a unified event system and learning infrastructure to the OpenCode AI Reviewer so it improves its review quality over time by learning from feedback, meta-evaluating its own output, and detecting recurring code issue patterns.

## 2. Architecture

```
GitHub Event → EventRouter → EventBus
  ├─ ReviewSubscriber     → ReviewEngine → post review → LearningStore.recordFinding()
  ├─ AuditSubscriber      → AuditEngine  → file issues
  ├─ FixSubscriber        → FixEngine    → apply + verify
  ├─ FeedbackSubscriber   → LearningStore.recordFeedback()
  └─ MetaReviewSubscriber → MetaReviewEngine → LearningStore.recordQuality()

On-demand (via /discover comment):
  PatternDetector → LearningStore.recordPattern() → suggestRule()
```

### 2.1 EventBus (`lib/src/event-bus/`)

- `EventRouter` — single entry point mapped to `app.on('*')`; categorizes raw GitHub events into typed internal events
- `EventBus` — maintains a registry of subscribers; each subscriber declares its subscribed event types via a `subscribedEvents` property
- `Subscriber` interface:
  ```typescript
  interface Subscriber {
    name: string;
    subscribedEvents: EventType[];
    handle(event: GitHubEvent): Promise<void>;
  }
  ```
- Event types (external): `pr.opened`, `pr.synchronize`, `pr.labeled`, `comment.created`, `review.submitted`, `review.dismissed`, `review_comment.dismissed`
- Event types (internal, published by subscribers): `review.completed`, `rule.approved`

### 2.2 LearningStore (`lib/src/learning/`)

SQLite database at `.opencode/learning.db` (auto-created, gitignored). Tables:

| Table | Columns | Purpose |
|---|---|---|
| `findings` | id, pr_number, type, severity, file, line, message, suggestion, created_at | Every review finding |
| `feedback` | id, finding_id, signal_type (dismissed/reaction/comment), signal_value, created_at | Developer feedback on findings |
| `review_quality` | id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score, created_at | Meta-review output |
| `patterns` | id, pattern_key (hash), message_cluster, frequency, file_types, first_seen, last_seen | Recurring issue patterns |
| `custom_rules` | id, rule_text, source (auto/manual), status (pending/active/declined), approved_at | Generated rules |
| `prompt_overrides` | id, category, override_text, false_positive_rate_before, created_at | Prompt adjustments |

Key methods: `recordFinding()`, `recordFeedback()`, `getFalsePositiveRate()`, `getRelevantLessons()`, `getQualityTrends()`

### 2.3 Feedback Collection

`FeedbackSubscriber` handles:
- `pull_request_review.dismissed` — marks all findings in that review as "dismissed"
- `pull_request_review_comment.dismissed` — marks specific finding as "dismissed"
- `issue_comment.created` — scans for "false positive" / "not an issue" / "wrong" → matches to last review's findings and marks as `disputed`

### 2.4 Meta-Review Subsystem (`lib/src/meta-review/`)

The MetaReviewSubscriber fires on every `review.completed` event (published by ReviewSubscriber after a review finishes), but only executes a meta-review every Nth review (default 5, configurable via `metaReview.interval`). It checks a counter stored in LearningStore to decide whether to run. Evaluates:
- **Actionability**: Were findings specific? (line numbers, concrete suggestions)
- **Accuracy**: Cross-reference with feedback table; calculate false positive rate
- **Coverage**: Were files with high churn/changed lines adequately reviewed?
- **Consistency**: Compare quality score distribution across recent reviews

Output: quality score + prompt override suggestions when FP rate > 30% for a rule category.

The MetaReviewSubscriber subscribes to the internal `review.completed` event (a new event type published by ReviewSubscriber after `ReviewEngine.reviewPR()` returns). It does NOT subscribe to any raw GitHub event — it's triggered internally.

### 2.5 Pattern Detector (`lib/src/pattern-detector/`)

Runs on demand via `/discover` comment or `pnpm run discover-patterns`. Process:
1. Query findings from LearningStore (last 100 or configurable window)
2. Cluster by message similarity (cosine similarity on embeddings or simple Jaccard on tokens)
3. If cluster size ≥ 3 across distinct PRs → candidate pattern
4. Call OpenCode to generate a concrete rule from the pattern
5. Write candidate to `custom_rules` table with `status: pending`
6. Create GitHub Issue/PR comment: "Found a recurring pattern. Proposed rule: `{rule}`. Reply with `/approve-rule` to add it to `.opencode-reviewer.yml`."
7. A `RuleApprovalSubscriber` listens for `/approve-rule` comments, updates the rule status to `active`, and appends it to `.opencode-reviewer.yml` via the GitHub API

### 2.6 Prompt Integration

Before each review, `ReviewEngine` calls `learningStore.getRelevantLessons(changedFiles)` and injects into the prompt:

```
## Historical Lessons
The following patterns were detected in similar code in past reviews:
- {auto-generated rule 1}
- {auto-generated rule 2}
```

This ensures every review benefits from past learnings.

## 3. Files Changed

### New files:
- `lib/src/event-bus/router.ts` — EventRouter class
- `lib/src/event-bus/bus.ts` — EventBus class
- `lib/src/event-bus/types.ts` — EventType, GitHubEvent, Subscriber interfaces
- `lib/src/learning/store.ts` — LearningStore (SQLite)
- `lib/src/learning/schema.ts` — DB schema creation and migrations
- `lib/src/meta-review/engine.ts` — MetaReviewEngine
- `lib/src/meta-review/prompts.ts` — Meta-review prompt templates
- `lib/src/pattern-detector/engine.ts` — PatternDetector
- `lib/src/pattern-detector/cluster.ts` — Finding clustering logic
- `lib/src/pattern-detector/rule-approval.ts` — RuleApprovalSubscriber

### Modified files:
- `app/src/index.ts` — Replace spread `app.on()` with single `app.on('*')` + EventRouter
- `lib/src/engine.ts` — Add `getRelevantLessons()` call before prompt building
- `lib/src/index.ts` — Export new modules
- `.opencode-reviewer.yml` — Add `metaReviewInterval`, `patternDiscovery` config sections

## 4. Dependencies

- `better-sqlite3` — zero-config SQLite (or `sql.js` for WASM-based, no native deps)

## 5. Configuration (`.opencode-reviewer.yml` additions)

```yaml
learning:
  enabled: true
  feedbackSignals:
    - "dismissed"
    - "reaction"
    - "disputed_comment"
  metaReview:
    enabled: true
    interval: 5
    minFindingsForReview: 3
  patternDiscovery:
    enabled: true
    minFrequency: 3
    windowSize: 100
```

## 6. Testing

- Unit tests for EventBus routing, LearningStore queries, clustering logic
- Integration test: submit fake findings → trigger pattern detector → verify rule is generated
- Integration test: submit findings → record feedback → verify false positive rate updates
