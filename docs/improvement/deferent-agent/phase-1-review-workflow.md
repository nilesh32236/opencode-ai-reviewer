# Phase 1 — Review Workflow Correctness: Verify, then Resolve, then Collapse

> **Goal:** Replace the current positional "minimize as OUTDATED" loop with a real verify→resolve→collapse workflow that (a) confirms a previously-reported issue is actually fixed before hiding the comment, (b) uses the existing-but-never-called `resolveReviewThread()` mutation when appropriate, and (c) re-opens comments that were incorrectly minimized in earlier iterations.

This phase addresses **Findings F-1 (review side), F-5, F-6, F-7, F-12** from the master plan.

---

## 1. Background — what's wrong today

### 1.1 The current collapse logic

The only comment-collapse logic in the codebase lives in the **Action's** autofix loop, `action/src/fix.ts:549-573`:

```ts
if (i > 0 && previousFindings.length > 0) {
  const prevIteration = previousFindings[previousFindings.length - 1];
  if (prevIteration.commentIds) {
    const currentIssueKeys = new Set(
      result.issues.map((issue) => `${issue.file}:${issue.line}`),
    );
    for (const prevComment of prevIteration.commentIds) {
      const key = `${prevComment.file}:${prevComment.line}`;
      if (!currentIssueKeys.has(key) && prevComment.nodeId) {
        await gh.minimizeReviewComment(prevComment.nodeId, 'OUTDATED');
      }
    }
  }
}
```

The decision rule is: **"if a previously-posted comment's `file:line` key is not present in the new review's issue list, minimize it."** That's it. There is no:

- Verification that the underlying code change actually addresses the issue.
- Distinction between "fixed", "outdated", "moved to a new line", and "dropped by the LLM".
- Re-evaluation of comments minimized in earlier iterations.
- Use of GitHub's "Resolve thread" UI affordance — the `resolveReviewThread()` mutation at `lib/src/utils/github.ts:1343-1354` is called via `resolveFixedComments` at `lib/src/utils/autofix-body.ts:249`, but only in the autofix loop. It is not invoked during standalone review runs or in the Action path, so threads remain unresolved when the block does not re-enter the fix loop.

### 1.2 Why this is a problem

The LLM is not deterministic. On iteration N it might report `src/auth.ts:42 — SQL injection`, then on iteration N+1 (after a fix attempt) it might:

- Correctly notice the issue is fixed → `currentIssueKeys` no longer contains `src/auth.ts:42` → minimize as OUTDATED. **Correct outcome, wrong classifier.** "OUTDATED" implies the comment was about code that no longer exists, but really it was about code that was fixed.
- Forget to re-report it because the diff truncated that file → minimize as OUTDATED. **Wrong outcome.** The issue is still there, but the comment is now hidden.
- Re-report the same issue at a slightly different line (say `src/auth.ts:45` after a refactor moved the function down) → `currentIssueKeys` contains `src/auth.ts:45` but not `src/auth.ts:42` → minimize the original as OUTDATED, post a duplicate at `:45`. **Worst outcome.** The thread now has a hidden original and a visible duplicate.

The user's complaint — "we resolve it not only resolve it using outdated if it really resolve then collapse issue comment" — maps exactly to this bug.

### 1.3 The never-called `resolveReviewThread()`

`lib/src/utils/github.ts:1343-1354` defines:

```ts
async resolveReviewThread(threadId: string): Promise<void> {
  await this.graphql(
    `mutation ResolveReviewThread($threadId: ID!) {
       resolveReviewThread(input: {threadId: $threadId}) {
         thread { isResolved resolvedBy { login } }
       }
     }`,
    { threadId },
  );
}
```

Grep confirms zero callers. This mutation is what GitHub uses to show a "Resolved" badge on a thread — the correct UI for "the maintainer (or bot) considers this addressed." The codebase has the tool, never uses it.

### 1.4 The `previouslyReported` flag that goes nowhere

The review prompt asks the LLM to tag persisting issues with `"previouslyReported": true` (`lib/src/prompts/builder.ts:236`), the schema declares the field (`lib/src/types/index.ts:60`, `lib/src/types/schemas.ts:42`), but neither the App nor the Action ever reads `previouslyReported` to decide what to do. The flag is collected and discarded. This is **Finding F-12**.

---

## 2. Design — the new verify→resolve→collapse flow

### 2.1 High-level flow

On every review iteration (after `engine.reviewPR` returns the new findings):

1. **Diff the previous iteration's findings against the current iteration's findings** by `file:line` key, but with a **fuzzy match window** of ±20 lines to absorb line shifts caused by refactors.
2. For each previous finding that has no match in the current iteration, **run a small LLM verifier** that reads the current file content and classifies the previous finding into one of four states.
3. **Act on each classification** per the table below.
4. **Log every decision** to a new `comment_actions` table in the LearningStore.
5. **Re-evaluate previously-minimized comments** in the same pass — if the verifier says `STILL_PRESENT`, un-minimize them.

### 2.2 The four-state classifier

| State | Meaning | Action | GitHub UI effect |
|---|---|---|---|
| `FIXED` | The code change addresses the issue. The LLM verifier can identify a specific commit / line range that addresses it. | Call `resolveReviewThread(threadId)` to mark the thread as Resolved. Do **not** minimize. | Thread shows "Resolved" badge. Visible but collapsed in the conversation. |
| `STILL_PRESENT` | The issue is still in the code at (or near) the original line. The LLM just didn't re-report it this iteration. | Leave the comment visible. If it was previously minimized, call `unminimizeReviewComment(nodeId)` to restore it. Re-tag the issue with `previouslyReported: true` in the new iteration's findings (so the maintainer sees it's a recurring issue). | Comment stays (or returns to) visible. |
| `MOVED` | The issue moved to a new line in the same file (e.g. a function was renamed or relocated). The LLM verifier identifies the new line. | Update the existing comment's body and line via GraphQL `updateReviewComment` mutation, preserving the thread history. Mark the thread resolved if the move was accompanied by a partial fix; otherwise leave open. | Comment moves to the new line in the diff view. |
| `OBSOLETE_CONTEXT` | The code that the comment was about no longer exists at all (file deleted, function removed, etc.). | Minimize as `OUTDATED`. This is the only state that minimizes. | Comment hidden behind "Show outdated". |

Note the asymmetry: **`FIXED` resolves, `OBSOLETE_CONTEXT` minimizes, `STILL_PRESENT` and `MOVED` keep the comment visible.** This matches the user's request: "if it really resolve then collapse issue comment" — collapse only happens when the issue is truly obsolete, not when it's fixed.

### 2.3 The verifier prompt

A new prompt file: `lib/src/prompts/verify-resolution.ts`. It takes:

- The previous finding's `file`, `line`, `message`, and `suggestion`.
- The current file content (fetched via the `read` tool — same pattern as `verify.ts`).
- The git diff between the previous review's head SHA and the current head SHA (so the verifier can see what changed).
- The PR's commit messages for that range.

And asks the LLM to emit a single JSON line:

```json
{"type":"verify_resolution","commentId":"...","state":"FIXED","evidence":"commit abc123 lines 40-48 in src/auth.ts replaced string concatenation with parameterized query","newLine":null}
```

`newLine` is populated only when `state === "MOVED"`. `evidence` is a short string (max 300 chars) that goes into the audit log.

The verifier must be a **separate LLM call** from the main review, because:

- It needs different context (the previous finding + the diff + the file content), not the full review context.
- It can use a smaller / cheaper model — `opencode/deepseek-v4-flash-free` is fine.
- It must not be influenced by the current iteration's findings (which would bias it toward `STILL_PRESENT`).

### 2.4 The fuzzy line match

To avoid spurious `MOVED` classifications when the LLM re-reports the same issue at a slightly different line:

```ts
function findFuzzyMatch(prev: {file: string, line: number}, current: {file: string, line: number}[], window = 20) {
  return current.find(c => c.file === prev.file && Math.abs(c.line - prev.line) <= window);
}
```

If a fuzzy match exists, skip the verifier for that previous finding — it's the same issue, the new comment will replace the old one in the thread.

### 2.5 The reconciliation pass

A new slash command `/reconcile-comments` (opt-in, not automatic) that:

1. Fetches all currently-minimized bot comments on the PR (via GraphQL `minimizedComments` query).
2. For each, runs the verifier against the current HEAD.
3. Un-minimizes any that classify as `STILL_PRESENT`.

This lets maintainers recover from the old buggy behavior on existing PRs without un-hiding everything en masse.

---

## 3. File-by-file changes

### 3.1 `lib/src/prompts/verify-resolution.ts` (NEW)

A new prompt builder, parallel to `lib/src/prompts/verify.ts`. Exports `buildVerifyResolutionPrompt(input)` that returns the prompt string. The prompt instructs the LLM to:

- Use the `read` tool to inspect the file at the current HEAD.
- Use the `git diff` (provided in the prompt) to see what changed since the comment was posted.
- Classify into `FIXED`, `STILL_PRESENT`, `MOVED`, or `OBSOLETE_CONTEXT`.
- Emit a single JSON line per input finding.

Prompt skeleton (abbreviated):

```markdown
You are a verification agent. For each previously-reported code review comment, classify whether the issue is now resolved.

For each comment, you will receive:
- The original file, line, message, and suggested fix.
- The current content of that file (use the `read` tool).
- The git diff between when the comment was posted and the current HEAD.

Classify each comment into exactly one of:
- FIXED: The code change addresses the issue. Cite the commit / line range as evidence.
- STILL_PRESENT: The issue is still in the code at (or near) the original line.
- MOVED: The issue moved to a new line in the same file. Provide the new line number.
- OBSOLETE_CONTEXT: The code the comment was about no longer exists (file deleted, function removed).

Output one JSON line per comment:
{"type":"verify_resolution","commentId":"...","state":"FIXED","evidence":"...","newLine":null}

Critical rules:
- DO NOT classify as FIXED unless you can identify a specific code change that addresses the issue.
- DO NOT classify as OBSOLETE_CONTEXT unless the file or function genuinely no longer exists.
- When in doubt, prefer STILL_PRESENT over FIXED. Hiding a real issue is worse than leaving a resolved comment visible.
```

### 3.2 `lib/src/utils/github.ts` (MODIFY)

Add three new methods:

```ts
/** Un-minimize a previously minimized comment. */
async unminimizeReviewComment(subjectId: string): Promise<void> {
  await this.graphql(
    `mutation UnminimizeComment($subjectId: ID!) {
       unminimizeComment(input: {subjectId: $subjectId}) {
         minimizedComment { isMinimized minimizedReason }
       }
     }`,
    { subjectId },
  );
}

/** Update a review comment's body. */
async updateReviewComment(commentId: string, body: string): Promise<void> {
  await this.octokit.rest.pulls.updateReviewComment({
    owner: this.owner, repo: this.repo, comment_id: Number(commentId), body,
  });
}

/** List all minimized comments authored by the bot on a PR. */
async listMinimizedBotComments(prNumber: number): Promise<MinimizedComment[]> {
  // Uses the same getReviewThreads GraphQL as getBotReviewThreads, but filters to isMinimized === true.
}
```

The existing `resolveReviewThread(threadId)` is already implemented — no change needed, just start calling it.

### 3.3 `lib/src/engine.ts` (MODIFY)

Add a new method `verifyResolution(input)`:

```ts
async verifyResolution(input: {
  previousFindings: Array<{ commentId: string; threadId?: string; file: string; line: number; message: string; suggestion?: string; nodeId?: string }>;
  headSha: string;
  previousHeadSha: string;
  workingDir: string;
}): Promise<VerifyResolutionResult[]>
```

This method:

1. For each previous finding, fetches the current file content from the working dir.
2. Fetches the diff `previousHeadSha..headSha` for that file (via `gh.getDiffSince` or `git diff`).
3. Builds the verify-resolution prompt.
4. Runs OpenCode with the prompt.
5. Parses the JSONL output.
6. Returns a typed array of `{ commentId, state, evidence, newLine }`.

### 3.4 `action/src/fix.ts` (MODIFY — the autofix loop)

Replace lines 549-573 with a call to a new shared helper:

```ts
if (i > 0 && previousFindings.length > 0) {
  const prevIteration = previousFindings[previousFindings.length - 1];
  if (prevIteration.commentIds) {
    const verifications = await engine.verifyResolution({
      previousFindings: prevIteration.commentIds.map(c => ({
        commentId: c.nodeId!,
        threadId: c.threadId,
        file: c.file, line: c.line,
        message: c.message, suggestion: c.suggestion, nodeId: c.nodeId,
      })),
      headSha: result.headSha,
      previousHeadSha: prevIteration.headSha,
      workingDir,
    });

    for (const v of verifications) {
      const prev = prevIteration.commentIds.find(c => c.nodeId === v.commentId);
      if (!prev) continue;

      switch (v.state) {
        case 'FIXED':
          if (prev.threadId) await gh.resolveReviewThread(prev.threadId);
          await logger.logCommentAction({ action: 'resolve', commentId: v.commentId, reason: v.evidence });
          break;
        case 'STILL_PRESENT':
          // Re-add to current findings with previouslyReported: true
          result.issues.push({ ...prev, previouslyReported: true });
          if (prev.wasMinimized) await gh.unminimizeReviewComment(prev.nodeId!);
          await logger.logCommentAction({ action: 'unminimize', commentId: v.commentId, reason: v.evidence });
          break;
        case 'MOVED':
          if (v.newLine) {
            await gh.updateReviewComment(prev.nodeId!, `${prev.body}\n\n_Updated: issue now at line ${v.newLine}._`);
            await logger.logCommentAction({ action: 'move', commentId: v.commentId, reason: v.evidence, newLine: v.newLine });
          }
          break;
        case 'OBSOLETE_CONTEXT':
          await gh.minimizeReviewComment(prev.nodeId!, 'OUTDATED');
          await logger.logCommentAction({ action: 'minimize', commentId: v.commentId, reason: v.evidence });
          break;
      }
    }
  }
}
```

### 3.5 `app/src/handlers/autofix.ts` (MODIFY)

The App's autofix loop currently has no minimization logic at all (Finding F-9). Add the same `verifyResolution` block as in 3.4. **Note:** Phase 5 will eventually consolidate this into `lib/src/autofix/loop.ts` and both paths will call it. Until Phase 5 lands, the two paths duplicate the new logic — that's acceptable for one release cycle, and Phase 5 is explicitly scoped to remove the duplication.

### 3.6 `lib/src/learning/schema.ts` (MODIFY) + `lib/src/learning/store.ts` (MODIFY)

Add a new `comment_actions` table:

```sql
CREATE TABLE IF NOT EXISTS comment_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL,
  comment_id TEXT NOT NULL,
  action TEXT NOT NULL,           -- 'resolve' | 'unminimize' | 'move' | 'minimize'
  reason TEXT NOT NULL,           -- evidence from the verifier
  new_line INTEGER,
  iteration INTEGER,
  head_sha TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comment_actions_pr ON comment_actions(pr_number);
CREATE INDEX IF NOT EXISTS idx_comment_actions_comment ON comment_actions(comment_id);
```

Add `logCommentAction(input)` and `getCommentActions(commentId)` methods to `LearningStore`. This is the audit trail that backs the `/why` command (see Phase 6).

### 3.7 `lib/src/types/index.ts` (MODIFY)

Add:

```ts
export type VerifyResolutionState = 'FIXED' | 'STILL_PRESENT' | 'MOVED' | 'OBSOLETE_CONTEXT';

export interface VerifyResolutionResult {
  commentId: string;
  state: VerifyResolutionState;
  evidence: string;
  newLine: number | null;
}
```

### 3.8 `lib/src/config.ts` + `lib/src/types/index.ts` (MODIFY)

Add a new config key:

```ts
review: {
  // ...existing keys...
  verifyResolution: boolean;        // default: false (opt-in for one release)
  verifyResolutionModel?: string;   // default: reviewModel
  fuzzyMatchWindow: number;         // default: 20
}
```

---

## 4. Tests

### 4.1 `lib/tests/verify-resolution.test.ts` (NEW)

Tests for the verifier prompt builder and the result parser:

- Builder includes the previous finding's file/line/message.
- Builder includes the current file content (mocked).
- Builder includes the diff.
- Parser correctly extracts `FIXED`, `STILL_PRESENT`, `MOVED`, `OBSOLETE_CONTEXT` from JSONL output.
- Parser handles malformed JSON gracefully (skip the line, log a warning).
- Parser handles the LLM emitting no JSONL (treat all as `STILL_PRESENT` — safe default).

### 4.2 `lib/tests/engine.test.ts` (MODIFY)

Add tests for `engine.verifyResolution`:

- Mocks OpenCode to return a fixed JSONL string.
- Asserts the returned `VerifyResolutionResult[]` matches.
- Asserts that file content is fetched from the working dir.
- Asserts that the diff is fetched via `gh.getDiffSince`.

### 4.3 `lib/tests/github.test.ts` (MODIFY)

Add tests for the three new GitHub methods:

- `unminimizeReviewComment` calls the right GraphQL mutation with the right args.
- `updateReviewComment` calls the right REST endpoint.
- `listMinimizedBotComments` filters to `isMinimized === true` and bot-authored threads.

### 4.4 `lib/tests/autofix-loop.test.ts` (NEW — also used by Phase 5)

Integration test that mocks the entire autofix loop:

- **Scenario A:** Previous iteration reported `src/auth.ts:42`. New iteration reports nothing at that line. Verifier returns `FIXED`. Assert `resolveReviewThread` is called, `minimizeReviewComment` is **not** called.
- **Scenario B:** Previous iteration reported `src/auth.ts:42`. New iteration reports nothing at that line. Verifier returns `STILL_PRESENT`. Assert `unminimizeReviewComment` is called (if previously minimized), the issue is re-added to current findings with `previouslyReported: true`, no minimize / resolve.
- **Scenario C:** Previous iteration reported `src/auth.ts:42`. New iteration reports `src/auth.ts:45`. Fuzzy match within ±20 lines → skip verifier, no action on the old comment, the new comment is posted normally.
- **Scenario D:** Previous iteration reported `src/auth.ts:42`. New iteration reports nothing. Verifier returns `MOVED` with `newLine: 78`. Assert `updateReviewComment` is called.
- **Scenario E:** Previous iteration reported `src/old.ts:42`. New iteration reports nothing. Verifier returns `OBSOLETE_CONTEXT` (file was deleted). Assert `minimizeReviewComment` is called with `'OUTDATED'`.
- **Scenario F:** Reconciliation pass — comment was minimized in an earlier iteration. New verifier returns `STILL_PRESENT`. Assert `unminimizeReviewComment` is called.

---

## 5. Acceptance Criteria

This phase is done when **all** of the following are true:

- [ ] The verifier prompt exists and is test-covered.
- [ ] `engine.verifyResolution` exists and is test-covered.
- [ ] `gh.unminimizeReviewComment`, `gh.updateReviewComment`, `gh.listMinimizedBotComments` exist and are test-covered.
- [ ] `gh.resolveReviewThread` is called somewhere (was previously dead code).
- [ ] The Action's autofix loop calls `verifyResolution` and acts per the four-state table.
- [ ] The App's autofix loop does the same.
- [ ] The `comment_actions` table exists in the LearningStore schema.
- [ ] `logCommentAction` and `getCommentActions` exist on `LearningStore`.
- [ ] `verifyResolution`, `verifyResolutionModel`, `fuzzyMatchWindow` config keys exist with defaults.
- [ ] The `/reconcile-comments` slash command exists and works.
- [ ] All six test scenarios (A–F) in 4.4 pass.
- [ ] No regression in the existing `lib/tests/engine.test.ts`, `lib/tests/github.test.ts`, `lib/tests/prompt-builder.test.ts` suites.

---

## 6. Rollout Steps

Ordered list of commits / PRs. Each PR should be mergeable on its own (no broken state between PRs).

1. **PR-1.1 — Foundations:** Add the `VerifyResolutionState` / `VerifyResolutionResult` types. Add the `comment_actions` table and `logCommentAction` / `getCommentActions` methods. Add the three new GitHub methods (`unminimizeReviewComment`, `updateReviewComment`, `listMinimizedBotComments`). No callers yet. All tests green.
2. **PR-1.2 — Verifier prompt + engine method:** Add `lib/src/prompts/verify-resolution.ts`. Add `engine.verifyResolution`. Unit-test both. No callers in the autofix loop yet.
3. **PR-1.3 — Wire into Action autofix loop:** Replace `action/src/fix.ts:549-573` with the new flow. Add the integration test scenarios A–F. Ship behind `review.verifyResolution: false` (opt-in).
4. **PR-1.4 — Wire into App autofix loop:** Same change in `app/src/handlers/autofix.ts`. (This PR is small; it's a copy of PR-1.3's logic. Phase 5 will remove the duplication.)
5. **PR-1.5 — `/reconcile-comments` command:** Add the slash command and its handler. Test-covered.
6. **PR-1.6 — Enable by default:** Flip the default of `review.verifyResolution` to `true`. Update `README.md` and `CHANGELOG.md`. Announce in the release notes that previously-minimized comments can be recovered with `/reconcile-comments`.

PRs 1.1 and 1.2 can land in parallel. PRs 1.3 and 1.4 depend on 1.2. PR 1.5 depends on 1.3. PR 1.6 lands last.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Verifier LLM is wrong about `FIXED` → real bug gets hidden behind "Resolved" badge | Medium | High | The verifier prompt explicitly says "When in doubt, prefer STILL_PRESENT". The `/reconcile-comments` command lets maintainers recover. The audit trail (`comment_actions` table) makes every decision reviewable. |
| Verifier LLM is wrong about `STILL_PRESENT` → resolved comment stays visible, noisy PR | Medium | Low | Cosmetic only. Maintainer can manually resolve. Less bad than hiding a real bug. |
| Extra LLM call per previous finding slows down the autofix loop | High | Medium | Verifier uses the cheap `flash-free` model. Parallelize verifier calls across findings (independent LLM calls). Cap at N=10 findings per iteration; above that, fall back to the old positional rule. |
| GraphQL `unminimizeComment` mutation requires `admin: write` scope that the bot might not have | Low | Medium | Test in a staging repo first. If scope is missing, log a warning and skip the un-minimize — the comment stays minimized but the audit trail records the intent. |
| Fuzzy match window of ±20 lines is too generous (matches unrelated issues in the same file) | Low | Medium | Make `fuzzyMatchWindow` configurable. Default 20 is conservative; can be lowered to 5 if false matches appear in practice. |
| Reconciliation pass un-minimizes hundreds of comments at once on legacy PRs | Medium | Medium | `/reconcile-comments` requires an opt-in label `reconcile-comments` on the PR before it runs. Posts a summary comment "Re-evaluated N comments: un-minimized M, kept K minimized" before doing anything destructive. |

---

## 8. Open Questions

1. **Verifier model choice:** Default to `reviewModel` (same as the main review) or to a cheaper `verifyResolutionModel`? Recommendation: separate `verifyResolutionModel` config key, defaulting to `opencode/deepseek-v4-flash-free` (cheap, fast).

2. **Parallel verifier calls:** Run the verifier for each previous finding in parallel, or sequentially? Recommendation: parallel with a concurrency limit of 5. The findings are independent.

3. **`/reconcile-comments` scope:** Should it operate on one PR, or scan all open PRs in the repo? Recommendation: one PR at a time. A repo-wide sweep is a separate `/reconcile-all` admin command (out of scope for Phase 1).

4. **`previouslyReported` re-tagging:** When the verifier says `STILL_PRESENT` and we re-add the issue to current findings with `previouslyReported: true`, should the new comment include a "⚠️ This issue was previously reported at line X" note? Recommendation: yes, in the comment body. Helps the maintainer see the history.

5. **Audit trail retention:** How long to keep rows in `comment_actions`? Recommendation: 90 days, with a periodic cleanup job. Aligns with the existing LearningStore retention.

---

End of Phase 1. Continue to `phase-2-issue-analysis.md`.
