# Phase 2 — Issue Analysis: Auto on Open, Manual `/analyze`, Structured Q&A Tracking

> **Goal:** Wire up automatic issue analysis on `issues.opened` (gated by config/label), refactor the existing `/analyze` command to share the same code path, store the analysis plan as **structured JSON** with typed `questionsForMaintainer[]`, and track each question's answer state in the LearningStore so Phase 3 can gate `/fix` on it.

This phase addresses **Findings F-3, F-4** from the master plan and lays the foundation for Phase 3's question gating.

---

## 1. Background — what's wrong today

### 1.1 No auto-analyze on issue open

The event router at `lib/src/event-bus/router.ts:5-29` maps these issue events:

```ts
case 'issues.labeled': return 'issue.labeled';
case 'issues.opened': return 'issue.opened';  // mapping exists
```

The App's subscriber list in `app/src/index.ts:303-311` registers nine subscribers, none of which subscribe to an `issue.opened` event. Opening a new GitHub issue triggers **nothing**. The only way to get an implementation plan is to manually comment `/analyze` (or `/fix`, which lazily generates a plan first).

The user's request: *"when the issue is open it should automatically anylize issue and create an implimeentation plan and rais questions if it has any make it automatically and also make it manual so we can run it using /anylize comment on issue"* — maps exactly to this gap.

### 1.2 The analysis plan is markdown-only, not structured

`engine.runAnalyze` at `lib/src/engine.ts:585-623` runs the LLM, writes the output to `.opencode/analysis-plan.md`, reads it back, and returns it as a **plain string**. The string is then posted as a comment with marker `<!-- issue-analysis-plan -->`.

The `AnalyzeResult` type at `lib/src/types/index.ts:534-553` declares structured fields:

```ts
export interface AnalyzeResult {
  issueNumber: number;
  summary: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  affectedFiles: string[];
  implementationPlan: string[];
  suggestions?: string[];
  questionsForMaintainer?: string[];   // ← defined, never populated
  rawMarkdown: string;
  createdAt: string;
}
```

…but `runAnalyze` returns `string`, not `AnalyzeResult`. The structured type is dead code. This is **Finding F-3**.

### 1.3 Questions are decorative

The analyze prompt at `lib/src/prompts/builder.ts:491-562` asks the LLM to populate a `## ❓ Questions / Decisions Needed from Maintainer` section in the markdown plan. The questions end up as text inside a comment. Nothing:

- Parses them out of the markdown.
- Tracks whether each individual question has been answered.
- Gates downstream actions (like `/fix`) on outstanding questions.
- Matches maintainer replies to specific questions.

The user's request: *"there is no need to forcefully asked questions if it really require answer from user then it should ask other wise it only need to create implimentation plan"* — implies the system should ask questions **only when genuinely needed** and otherwise just create the plan. Today the prompt always includes the "Questions" section header, which can lead the LLM to invent questions even when none are needed.

### 1.4 Manual `/analyze` and auto-analyze should share code

Today there is exactly one code path: `handleAnalyzeCommand` in `app/src/handlers/commands.ts:143-176` (called by the `/analyze` subscriber). The Action has its own `runAnalyze` in `action/src/analyze.ts:17-51`. Both call `engine.runAnalyze`. When we add auto-analyze, we should reuse `handleAnalyzeCommand` (or extract a shared helper) so that the manual and automatic flows produce identical output.

---

## 2. Design — structured analysis with question tracking

### 2.1 High-level flow

1. **On `issues.opened`** (gated by `analyze.autoOnOpen: true` config OR an opt-in label `analyze-on-open`), the App runs the same `handleAnalyzeCommand` that powers `/analyze`.
2. **The analyze prompt is refactored** to emit **both** a markdown plan (for the comment) and a JSON sidecar (for machine consumption). The JSON sidecar has typed `questionsForMaintainer[]` with stable `questionId`s.
3. **The JSON sidecar is committed to the workspace** at `.opencode/analysis-plan.json` and also written to a new `analysis_plans` table in the LearningStore.
4. **Each question gets a row in a new `issue_questions` table** with `askedAt`, `answeredAt` (nullable), `answerText` (nullable), `answeredBy` (nullable).
5. **A new reply subscriber** watches issue comments and matches them to open questions. Matching is by:
   - Quoted text (if the maintainer used GitHub's "Quote reply" on the question).
   - Reply-to marker (if the maintainer's comment is a reply to the bot's question comment).
   - Sequential ordering (if the maintainer just posts a comment listing answers, the Nth answer matches the Nth open question — fragile, but a useful fallback).
6. **Manual `/analyze` re-runs the flow and updates the structured state.** Re-running `/analyze` invalidates open questions (marks them `supersededAt`) and asks new ones.

### 2.2 The two-output prompt

Today the prompt asks for one markdown file. The new prompt asks for **two files**:

1. `.opencode/analysis-plan.md` — the human-readable plan (same as today, posted as a comment).
2. `.opencode/analysis-plan.json` — the machine-readable sidecar.

The JSON schema:

```json
{
  "issueNumber": 42,
  "summary": "Short summary of the issue",
  "priority": "high",
  "affectedFiles": ["src/auth.ts", "tests/auth.test.ts"],
  "implementationPlan": [
    "Add input validation in src/auth.ts:loginUser()",
    "Add unit tests for invalid input cases",
    "Update CHANGELOG.md"
  ],
  "suggestions": ["Consider using zod for schema validation"],
  "questionsForMaintainer": [
    {
      "questionId": "q1",
      "question": "Should we use zod or yup for runtime validation?",
      "context": "Both are already in the dependency tree.",
      "required": true
    }
  ],
  "createdAt": "2026-07-26T10:00:00Z"
}
```

The prompt explicitly instructs the LLM:

> **Only include `questionsForMaintainer` entries when the answer genuinely changes the implementation.** Do not ask questions that you can answer yourself by reading the codebase. Do not ask preference questions ("any thoughts?"). Each question must have a `questionId` (q1, q2, ...) and a `required` flag (`true` if the fix cannot proceed without an answer, `false` if the LLM can pick a sensible default).

This addresses the user's "no need to forcefully asked questions if it really require answer from user" requirement.

### 2.3 The `issue_questions` table

```sql
CREATE TABLE IF NOT EXISTS issue_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,                -- "owner/repo"
  issue_number INTEGER NOT NULL,
  question_id TEXT NOT NULL,         -- "q1", "q2", ...
  question_text TEXT NOT NULL,
  context TEXT,
  required INTEGER NOT NULL,         -- 0 or 1
  asked_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT,
  answer_text TEXT,
  answered_by TEXT,
  superseded_at TEXT,                -- set when /analyze re-runs
  UNIQUE(repo, issue_number, question_id)
);
CREATE INDEX IF NOT EXISTS idx_issue_questions_open
  ON issue_questions(repo, issue_number, answered_at)
  WHERE answered_at IS NULL AND superseded_at IS NULL;
```

Methods on `LearningStore`:

```ts
async recordQuestions(repo: string, issueNumber: number, questions: QuestionInput[]): Promise<void>;
async getOpenQuestions(repo: string, issueNumber: number): Promise<IssueQuestion[]>;
async getAnsweredQuestions(repo: string, issueNumber: number): Promise<IssueQuestion[]>;
async markQuestionAnswered(repo: string, issueNumber: number, questionId: string, answer: { text: string; by: string }): Promise<void>;
async supersedeOpenQuestions(repo: string, issueNumber: number): Promise<void>;  // called when /analyze re-runs
```

### 2.4 The reply-matching subscriber

A new subscriber in `app/src/index.ts`:

```ts
class IssueReplySubscriber {
  // Listens to: issue_comment.created on issues that have open questions
  async handle(event) {
    const repo = `${event.payload.repository.owner.login}/${event.payload.repository.name}`;
    const issueNumber = event.payload.issue.number;
    const commenter = event.payload.comment.user.login;
    if (commenter === 'opencode-reviewer[bot]') return;  // skip self

    const openQuestions = await store.getOpenQuestions(repo, issueNumber);
    if (openQuestions.length === 0) return;  // nothing to match

    const matches = matchAnswersToQuestions(event.payload.comment.body, openQuestions);
    for (const m of matches) {
      await store.markQuestionAnswered(repo, issueNumber, m.questionId, {
        text: m.answerText,
        by: commenter,
      });
    }

    if (matches.length > 0 && matches.length < openQuestions.length) {
      // Some questions still open — post a friendly reminder
      await gh.postComment(issueNumber, `Thanks! I've recorded answers to ${matches.length} question(s). Still waiting on: ${openQuestions.filter(q => !matches.find(m => m.questionId === q.questionId)).map(q => q.questionId).join(', ')}`);
    }
  }
}
```

The `matchAnswersToQuestions` function tries three strategies in order:

1. **Quote-based:** If the comment contains a `> ` quoted block matching a question's text, the text after the quote is the answer.
2. **Reply-to-based:** If the comment has `in_reply_to_id` pointing at the bot's question comment, the entire comment body is the answer to all open questions in that comment (if there's only one open question) or the Nth answer (if numbered).
3. **Numbered-list-based:** If the comment contains a numbered list (`1.`, `2.`, ...), the Nth item answers question `qN`.

If no strategy matches, no questions are marked answered. The maintainer can always manually run `/answer q1="use zod"` to force-record an answer.

### 2.5 The `issues.opened` subscriber

```ts
class IssueOpenedSubscriber {
  async handle(event) {
    const repo = `${event.payload.repository.owner.login}/${event.payload.repository.name}`;
    const issueNumber = event.payload.issue.number;
    const config = await loadConfig(repo);

    const shouldAnalyze =
      config.analyze.autoOnOpen ||
      event.payload.issue.labels.some(l => l.name === config.analyze.autoOnOpenLabel);

    if (!shouldAnalyze) return;
    if (event.payload.issue.pull_request) return;  // skip PRs

    await handleAnalyzeCommand(issueNumber, repo, getToken(), config);
  }
}
```

And in `lib/src/event-bus/router.ts:5-29`, add:

```ts
case 'issues.opened': return 'issue.opened';
```

### 2.6 The `handleAnalyzeCommand` refactor

Today `handleAnalyzeCommand` (in `app/src/handlers/commands.ts:143-176`) is a thin wrapper that calls `engine.runAnalyze` and posts the markdown as a comment. The refactor:

1. Call `engine.runAnalyze` (which now returns `AnalyzeResult`, not `string`).
2. Post the `rawMarkdown` as a comment with marker `<!-- issue-analysis-plan -->`.
3. If `result.questionsForMaintainer.length > 0`, post a **second** comment with marker `<!-- issue-questions -->` that lists each question with its `questionId` and a copy-paste-friendly "Quote reply" prompt.
4. Call `store.supersedeOpenQuestions(repo, issueNumber)` (invalidate any prior open questions from a previous `/analyze` run).
5. Call `store.recordQuestions(repo, issueNumber, result.questionsForMaintainer)`.

The second comment (the questions comment) is what the maintainer replies to. Splitting it from the plan comment keeps the plan comment readable and gives the reply subscriber a clean target.

---

## 3. File-by-file changes

### 3.1 `lib/src/event-bus/router.ts` (MODIFY)

Add the `issues.opened` mapping:

```ts
case 'issues.opened': return 'issue.opened';
case 'issues.labeled': return 'issue.labeled';
case 'issues.closed': return 'issue.closed';   // bonus: future hook for cleanup
```

### 3.2 `lib/src/prompts/builder.ts` (MODIFY)

Refactor `buildAnalyzePrompt` (`lib/src/prompts/builder.ts:491-562`):

- Remove the unconditional "❓ Questions / Decisions Needed from Maintainer" section header. Replace with conditional instructions: "Only if a decision genuinely cannot be made without maintainer input, include a `questionsForMaintainer` array in the JSON output."
- Add the JSON sidecar schema to the prompt.
- Add the matching rules: each question has `questionId`, `question`, `context`, `required`.
- Add the "do not ask preference questions" rule.

### 3.3 `lib/src/engine.ts` (MODIFY)

Refactor `runAnalyze` (`lib/src/engine.ts:585-623`):

- After the LLM runs, read **both** `.opencode/analysis-plan.md` and `.opencode/analysis-plan.json` from the working dir.
- Parse the JSON, validate against a Zod schema, and return an `AnalyzeResult` object (not a string).
- If the JSON is missing or invalid, fall back to constructing an `AnalyzeResult` with `questionsForMaintainer: []` and log a warning.

### 3.4 `lib/src/types/index.ts` + `lib/src/types/schemas.ts` (MODIFY)

Update `AnalyzeResult` to use the new `IssueQuestion` shape:

```ts
export interface IssueQuestion {
  questionId: string;       // "q1", "q2", ...
  question: string;
  context?: string;
  required: boolean;
}

export interface AnalyzeResult {
  issueNumber: number;
  summary: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  affectedFiles: string[];
  implementationPlan: string[];
  suggestions?: string[];
  questionsForMaintainer: IssueQuestion[];   // ← now typed and always an array (possibly empty)
  rawMarkdown: string;
  createdAt: string;
}
```

Add Zod schemas mirroring these types.

### 3.5 `lib/src/learning/schema.ts` (MODIFY) + `lib/src/learning/store.ts` (MODIFY)

Add the `issue_questions` table (SQL in §2.3 above) and the `recordQuestions` / `getOpenQuestions` / `getAnsweredQuestions` / `markQuestionAnswered` / `supersedeOpenQuestions` methods.

Also add an `analysis_plans` table for the full plan (so we can retrieve it later without scraping the comment):

```sql
CREATE TABLE IF NOT EXISTS analysis_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  plan_json TEXT NOT NULL,           -- the full AnalyzeResult JSON
  plan_markdown TEXT NOT NULL,       -- the human-readable markdown
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_analysis_plans_current
  ON analysis_plans(repo, issue_number)
  WHERE superseded_at IS NULL;
```

Methods:

```ts
async recordAnalysisPlan(repo: string, issueNumber: number, plan: AnalyzeResult): Promise<void>;
async getCurrentAnalysisPlan(repo: string, issueNumber: number): Promise<AnalyzeResult | null>;
```

### 3.6 `lib/src/learning/issue-questions.ts` (NEW)

A new module with the `matchAnswersToQuestions` function and the reply-matching strategies. Pure functions, easy to unit-test.

### 3.7 `app/src/handlers/issue-opened.ts` (NEW)

The `IssueOpenedSubscriber` class (skeleton in §2.5 above).

### 3.8 `app/src/handlers/issue-reply.ts` (NEW)

The `IssueReplySubscriber` class (skeleton in §2.4 above). Subscribes to `issue_comment.created` and dispatches to `matchAnswersToQuestions`.

### 3.9 `app/src/handlers/commands.ts` (MODIFY)

Refactor `handleAnalyzeCommand` per §2.6. The new flow:

```ts
export async function handleAnalyzeCommand(issueNumber, repo, token, config) {
  const gh = new GitHubHelper(...);
  const engine = new ReviewEngine(...);
  const store = new LearningStore(...);

  const issueContext = await gh.gatherContext({ issueNumber });
  const result = await engine.runAnalyze(issueNumber, issueContext, undefined, tempDir);

  // Update or post the plan comment
  await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', result.rawMarkdown);

  // Record the plan in the DB
  await store.supersedeOpenQuestions(repo, issueNumber);
  await store.recordAnalysisPlan(repo, issueNumber, result);
  await store.recordQuestions(repo, issueNumber, result.questionsForMaintainer);

  // Post (or update) the questions comment
  if (result.questionsForMaintainer.length > 0) {
    const questionsMd = renderQuestionsComment(result.questionsForMaintainer);
    await gh.postOrUpdateComment(issueNumber, '<!-- issue-questions -->', questionsMd);
  } else {
    // Remove any prior questions comment if no questions this run
    await gh.deleteCommentByMarker(issueNumber, '<!-- issue-questions -->');
  }
}
```

### 3.10 `app/src/index.ts` (MODIFY)

Register the two new subscribers:

```ts
const subscribers = [
  // ...existing...
  new IssueOpenedSubscriber(...),
  new IssueReplySubscriber(...),
];
```

### 3.11 `action/src/analyze.ts` (MODIFY)

Update `runAnalyze` to mirror the App's `handleAnalyzeCommand` refactor (post the plan comment, record in DB, post the questions comment). Ideally extract the shared logic into `lib/src/analyze/handler.ts` so both App and Action call it — but that's also part of Phase 5's consolidation. For Phase 2, duplicate the logic with a TODO pointing to Phase 5.

### 3.12 `lib/src/config.ts` + `lib/src/types/index.ts` (MODIFY)

Add new config keys:

```ts
analyze: {
  autoOnOpen: boolean;          // default: false
  autoOnOpenLabel: string;      // default: 'analyze-on-open'
  skipLabels: string[];         // default: ['wontfix', 'duplicate', 'invalid']
  model?: string;               // default: reviewModel
  askQuestions: boolean;        // default: true; can be set to false to suppress all questions
}
```

The `askQuestions: false` config gives the maintainer a way to disable the question feature entirely if they want analyze to be plan-only.

---

## 4. Tests

### 4.1 `lib/tests/prompt-builder.test.ts` (MODIFY)

Add tests for the refactored `buildAnalyzePrompt`:

- Prompt includes the JSON sidecar schema.
- Prompt includes the "do not ask preference questions" rule.
- Prompt does NOT include the unconditional "❓ Questions" header.

### 4.2 `lib/tests/engine.test.ts` (MODIFY)

Add tests for the refactored `runAnalyze`:

- Returns `AnalyzeResult`, not `string`.
- Parses the JSON sidecar correctly.
- Falls back gracefully if the JSON is missing (returns `questionsForMaintainer: []`).
- Falls back gracefully if the JSON is invalid (logs warning, returns `questionsForMaintainer: []`).

### 4.3 `lib/tests/issue-questions.test.ts` (NEW)

Tests for `matchAnswersToQuestions`:

- Quote-based matching: comment contains `> Should we use zod?` followed by "Use zod" → matches `q1`.
- Reply-to-based matching: comment is a reply to the questions comment, body is "q1: use zod, q2: yes" → matches both.
- Numbered-list matching: comment is "1. use zod\n2. yes" → matches `q1` and `q2`.
- No match: comment is "thanks!" → no questions marked answered.
- Mixed: comment contains a quote match for `q1` and a numbered answer for `q2` → both matched.

### 4.4 `lib/tests/learning-store.test.ts` (MODIFY)

Add tests for the new methods:

- `recordQuestions` inserts rows.
- `recordQuestions` is idempotent for the same `(repo, issueNumber, questionId)`.
- `getOpenQuestions` returns only rows with `answered_at IS NULL AND superseded_at IS NULL`.
- `markQuestionAnswered` sets `answered_at`, `answer_text`, `answered_by`.
- `supersedeOpenQuestions` sets `superseded_at` on all open questions for the issue.
- `recordAnalysisPlan` inserts a new row; `getCurrentAnalysisPlan` returns the most recent non-superseded row.

### 4.5 `lib/tests/issue-opened.test.ts` (NEW)

Tests for `IssueOpenedSubscriber`:

- With `analyze.autoOnOpen: false` and no label → does nothing.
- With `analyze.autoOnOpen: false` and label `analyze-on-open` → calls `handleAnalyzeCommand`.
- With `analyze.autoOnOpen: true` and no label → calls `handleAnalyzeCommand`.
- With a PR payload (not an issue) → does nothing.
- With a skip label `wontfix` → does nothing.

### 4.6 `lib/tests/issue-reply.test.ts` (NEW)

Tests for `IssueReplySubscriber`:

- No open questions → does nothing.
- Open questions, comment from bot → does nothing.
- Open questions, comment from maintainer with quote match → marks question answered, posts the "still waiting on" reminder if some remain open.
- Open questions, comment from maintainer with no match → does nothing.

---

## 5. Acceptance Criteria

This phase is done when **all** of the following are true:

- [ ] `issues.opened` is mapped in the event router.
- [ ] `IssueOpenedSubscriber` exists, is registered, and is test-covered.
- [ ] `IssueReplySubscriber` exists, is registered, and is test-covered.
- [ ] `buildAnalyzePrompt` produces the two-output prompt (markdown + JSON sidecar).
- [ ] `engine.runAnalyze` returns `AnalyzeResult` (not `string`).
- [ ] The JSON sidecar is validated with Zod.
- [ ] `issue_questions` and `analysis_plans` tables exist in the LearningStore schema.
- [ ] `recordQuestions`, `getOpenQuestions`, `getAnsweredQuestions`, `markQuestionAnswered`, `supersedeOpenQuestions`, `recordAnalysisPlan`, `getCurrentAnalysisPlan` all exist and are test-covered.
- [ ] `matchAnswersToQuestions` implements all three matching strategies and is test-covered.
- [ ] `handleAnalyzeCommand` posts both the plan comment and (if questions exist) the questions comment.
- [ ] `handleAnalyzeCommand` records the plan and questions in the DB.
- [ ] Re-running `/analyze` supersedes prior open questions.
- [ ] The `analyze.autoOnOpen`, `analyze.autoOnOpenLabel`, `analyze.skipLabels`, `analyze.model`, `analyze.askQuestions` config keys exist with defaults.
- [ ] All test files in §4 pass.
- [ ] No regression in existing tests.

---

## 6. Rollout Steps

1. **PR-2.1 — Schemas & storage:** Add the `issue_questions` and `analysis_plans` tables. Add the `IssueQuestion` and updated `AnalyzeResult` types. Add all the new `LearningStore` methods. No callers yet. Tests for the store methods.
2. **PR-2.2 — Prompt + engine refactor:** Refactor `buildAnalyzePrompt` for two outputs. Refactor `engine.runAnalyze` to return `AnalyzeResult`. Update `handleAnalyzeCommand` and `action/src/analyze.ts:runAnalyze` to consume the new return type. At this point, `/analyze` posts the same plan comment as before (no behavior change yet) but the structured data is being captured in the DB.
3. **PR-2.3 — Questions comment:** Update `handleAnalyzeCommand` to post the separate `<!-- issue-questions -->` comment when questions exist. Add tests.
4. **PR-2.4 — Reply matching:** Add `matchAnswersToQuestions` and the `IssueReplySubscriber`. Add tests. Now maintainer replies can mark questions answered.
5. **PR-2.5 — Auto-analyze on issue open:** Add the `issues.opened` mapping, the `IssueOpenedSubscriber`, the `analyze.autoOnOpen` / `analyze.autoOnOpenLabel` config keys. Default `autoOnOpen: false`. Add tests.
6. **PR-2.6 — Enable auto-on-open in example workflows:** Update `examples/basic/review.yml` to show the opt-in label workflow. Update `README.md` with a "Auto-analyze on issue open" section.

PRs 2.1 and 2.2 are independent and can land in parallel. PR 2.3 depends on 2.2. PR 2.4 depends on 2.1. PR 2.5 depends on 2.1 and 2.2. PR 2.6 depends on 2.5.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LLM still over-asks questions despite the new prompt rules | High | Medium | The `analyze.askQuestions: false` config gives maintainers a hard override. The Phase 3 question-gating logic uses `required: true` to distinguish "must answer" from "would be nice" — only `required: true` questions block `/fix`. |
| Reply matching produces false positives (marks a question answered when it wasn't) | Medium | High | The matching strategies are conservative — they only match when there's clear evidence (quote, reply-to, numbered list). The "still waiting on" reminder lets the maintainer catch false positives. Maintainer can run `/analyze` again to re-open. |
| Reply matching produces false negatives (maintainer answered but it wasn't matched) | Medium | Low | The maintainer can use `/answer q1="use zod"` as a manual override. The `/fix` command (Phase 3) will surface "I still have open questions: q1, q2" so the maintainer knows. |
| Auto-analyze on issue open fires on spam / duplicate issues | Medium | Medium | The `analyze.skipLabels` config defaults to `['wontfix', 'duplicate', 'invalid']`. Maintainers can label spam as `invalid` before the bot runs (race condition, but acceptable). Alternatively, the subscriber can wait N seconds after `issues.opened` and re-check labels before running. |
| JSON sidecar is malformed | Low | Low | Zod validation catches it; `runAnalyze` falls back to `questionsForMaintainer: []`. The markdown plan is still posted. The DB record is still created with what was parsed. |
| Existing PRs that rely on the old `<!-- issue-analysis-plan -->` marker break | Low | Low | The marker is preserved. The plan comment format is unchanged. Only the internal storage and the additional `<!-- issue-questions -->` comment are new. |
| Database bloat from `analysis_plans` and `issue_questions` on busy repos | Low | Medium | Same 90-day retention as Phase 1's `comment_actions` table. Add a periodic cleanup job in Phase 6. |

---

## 8. Open Questions

1. **Should `analyze.autoOnOpen` default to `true` or `false`?** Recommendation: `false` for one release, then `true`. Repos with high issue volume may want to keep it off.

2. **Should the questions comment be a separate comment, or appended to the plan comment?** Recommendation: separate comment. The plan comment is meant to be readable; the questions comment is interactive. Mixing them makes both worse.

3. **Should `matchAnswersToQuestions` use an LLM for fuzzy matching, or stick to deterministic strategies?** Recommendation: deterministic for Phase 2. If false-negative rate is high in practice, add an LLM-based fallback in Phase 6.

4. **Should the `<!-- issue-questions -->` comment be edited in place when questions are answered, or left as-is?** Recommendation: edit in place. Strike through answered questions, leaving the unanswered ones visible. This makes the thread history clear.

5. **Should `/analyze` accept arguments (e.g. `/analyze --no-questions`)?** Recommendation: yes. Add `--no-questions` (suppresses questions even if the LLM would ask them) and `--re-ask` (forces re-asking even of answered questions). Land in Phase 4 alongside the other command-flag work.

---

End of Phase 2. Continue to `phase-3-autofix-gating.md`.
