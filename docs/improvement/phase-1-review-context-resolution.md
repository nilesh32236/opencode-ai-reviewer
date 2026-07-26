# Phase 1 — PR Review: Conversation Context & Proper Issue Resolution

> **Severity:** High  
> **Effort:** Medium (3–5 days)  
> **Dependencies:** None — self-contained changes

---

## Problems Being Solved

### Problem 1.1 — Open conversations not passed as review context

**Current behavior:**  
`engine.reviewPR()` gathers the PR's changed files and diffs, but does **not** include the body of open (unresolved) review comment threads. This means if a reviewer left a comment thread with questions or objections, the bot reviews the next push without knowing those threads exist.

**Where it happens:**  
`lib/src/engine.ts → reviewPR()` builds `baseContext` from the PR metadata + diff. The `previousBotComments` parameter only holds the bot's own past comments, not all open human threads.

**Impact:**  
- Bot may approve code that still has unaddressed human reviewer comments
- Bot may re-raise issues that a human already commented on
- Context for the model is incomplete — it cannot see what humans have flagged

---

### Problem 1.2 — Issues resolved with "OUTDATED" instead of genuinely verified

**Current behavior:**  
In `action/src/fix.ts → runAutofixLoop()`, after each fix iteration, the code does:
```ts
await gh.minimizeReviewComment(prevComment.nodeId, 'OUTDATED');
```
This marks the comment as minimized with the `OUTDATED` classifier. It does **not** resolve the thread. The comment just gets visually hidden — but it is not verified that the underlying issue was actually fixed.

The `resolveReviewThread` GraphQL mutation exists in `github.ts` and is called via `resolveFixedComments` in the autofix loop, but is not invoked during standalone review runs.

**Where it happens:**  
`action/src/fix.ts` (lines ~340–360) — the autofix loop's post-review pass  
`app/src/handlers/autofix.ts` — same logic in the Probot path (does not even do the minimize — it never clears old comments at all)

**Impact:**  
- Stale bot comments pile up on PRs
- "Resolved" issues that aren't really resolved appear cleared
- Genuinely fixed issues are not collapsed/resolved, cluttering the PR

---

## Proposed Solution

### Step 1 — Gather open human review threads as context

**File:** `lib/src/utils/github.ts`

Add a new method `getOpenHumanThreads(prNumber)` that:
1. Calls `getReviewThreads(prNumber)` (already exists)
2. Filters to threads where:
   - `isResolved === false`
   - The first comment's author is NOT the bot
3. Returns them formatted as a markdown summary

```ts
async getOpenHumanThreads(prNumber: number): Promise<string> {
  const threads = await this.getReviewThreads(prNumber);
  const botLogin = await this.getCurrentUser();
  const botBase = botLogin.toLowerCase().replace(/\[bot\]$/, '');

  const openHumanThreads = threads.filter((t) => {
    if (t.isResolved) return false;
    const author = t.firstComment.author.toLowerCase().replace(/\[bot\]$/, '');
    return author !== botBase;
  });

  if (openHumanThreads.length === 0) return '';

  const lines: string[] = ['## Open Review Threads (Unresolved)', ''];
  for (const thread of openHumanThreads) {
    const fc = thread.firstComment;
    lines.push(`### Thread on \`${fc.filePath}:${fc.lineNumber ?? '?'}\``);
    lines.push(`**Author:** @${fc.author}  |  **Created:** ${fc.createdAt}`);
    lines.push('');
    lines.push(fc.body);
    lines.push('');
  }
  return lines.join('\n');
}
```

**File:** `lib/src/engine.ts → reviewPR()`

In the `baseContext` assembly (after fetching PR metadata), call `getOpenHumanThreads`:

```ts
// Before building the review prompt:
const openThreadsContext = await this.github.getOpenHumanThreads(pr.number);
if (openThreadsContext) {
  baseContext += '\n\n' + openThreadsContext;
}
```

This ensures the LLM knows which threads are still open when it reviews.

---

### Step 2 — Pass existing unresolved bot issues as context too

**Current state:** `previousBotComments` is fetched in `action/src/review.ts` and passed to `reviewPR()`, but is only used in the action path. The Probot autofix path in `autofix.ts` does not fetch or pass them.

**Fix:** In `app/src/handlers/autofix.ts → handleAutofixLoop()`, before calling `engine.reviewPR()`, fetch the bot's open threads:

```ts
// Fetch open bot threads for context
let previousBotComments: Array<{...}> | undefined;
try {
  const botThreads = await gh.getBotReviewThreads(prNumber);
  previousBotComments = botThreads
    .filter(t => !t.isResolved && t.firstComment)
    .map(t => ({
      file: t.firstComment!.filePath,
      line: t.firstComment!.lineNumber,
      body: t.firstComment!.body,
      commentId: t.firstComment!.databaseId,
    }));
} catch (err) {
  logger.warn(`Could not fetch previous bot comments: ${err}`);
}

// Pass to reviewPR:
result = await engine.reviewPR(
  pr, i, undefined, undefined, undefined, undefined, reviewWorkingDir, undefined, previousBotComments
);
```

---

### Step 3 — Proper resolution logic: verify before resolving

**The new `resolveIfFixed()` helper:**

After each review iteration, instead of blindly marking all old comments as OUTDATED, implement a smarter check:

```ts
async function resolveFixedComments(
  gh: GitHubHelper,
  prNumber: number,
  previousFindings: PreviousFindingIteration[],
  currentIssues: ReviewIssue[],
  logger: Logger,
): Promise<void> {
  if (previousFindings.length === 0) return;

  const lastIteration = previousFindings[previousFindings.length - 1];
  if (!lastIteration.commentIds || lastIteration.commentIds.length === 0) return;

  // Build a set of still-present issues by file:line key
  const stillOpenKeys = new Set(
    currentIssues.map(issue => `${issue.file}:${issue.line}`)
  );

  for (const prevComment of lastIteration.commentIds) {
    const key = `${prevComment.file}:${prevComment.line}`;

    if (!stillOpenKeys.has(key) && prevComment.nodeId) {
      try {
        // Get the thread ID for this comment via GraphQL
        const threads = await gh.getReviewThreads(prNumber);
        const thread = threads.find(
          t => t.firstComment.databaseId === prevComment.commentId
        );

        if (thread && !thread.isResolved) {
          // RESOLVE the thread — the issue is genuinely gone
          await gh.resolveReviewThread(thread.threadId);
          logger.info(
            `Resolved thread for ${prevComment.file}:${prevComment.line} — issue verified fixed`
          );
        }
      } catch (err) {
        logger.warn(
          `Could not resolve thread for comment ${prevComment.commentId}: ${err}`
        );
        // Fallback: minimize as RESOLVED (not OUTDATED)
        if (prevComment.nodeId) {
          try {
            await gh.minimizeReviewComment(prevComment.nodeId, 'RESOLVED');
          } catch { /* ignore */ }
        }
      }
    }
  }
}
```

**Key distinction from current code:**
- Current: `minimizeReviewComment(..., 'OUTDATED')` — hides the comment, does not resolve thread
- New: `resolveReviewThread(thread.threadId)` — actually resolves the thread (GitHub shows it as resolved)
- Fallback: `minimizeReviewComment(..., 'RESOLVED')` — if GraphQL thread ID can't be found

**Where to call it:**
- `action/src/fix.ts → runAutofixLoop()` — replace the existing minimize block
- `app/src/handlers/autofix.ts → handleAutofixLoop()` — add the same call

---

### Step 4 — Close linked issue when PR is merged and all issues resolved

**Current state:** The `notify-merged` job in `self-review.yml` posts a comment but does not close the linked issue.

**Fix:** In `app/src/handlers/autofix.ts`, when the PR is approved (verdict === ready):

```ts
if (pr.linkedIssue) {
  try {
    await gh.closeIssue(
      pr.linkedIssue,
      `✅ Resolved by PR #${prNumber} — all review items verified fixed.\n\n*Auto-closed by opencode-ai-reviewer*`
    );
    logger.info(`Closed linked issue #${pr.linkedIssue}`);
  } catch (err) {
    logger.warn(`Could not close linked issue #${pr.linkedIssue}: ${err}`);
  }
}
```

The `closeIssue()` method already exists in `github.ts`.

---

## Implementation Checklist

- [ ] `lib/src/utils/github.ts` — Add `getOpenHumanThreads(prNumber)` method
- [ ] `lib/src/engine.ts` — Append open human thread context to `baseContext` in `reviewPR()`
- [ ] `app/src/handlers/autofix.ts` — Fetch and pass `previousBotComments` to `reviewPR()`
- [ ] `action/src/fix.ts` — Replace `minimizeReviewComment('OUTDATED')` with `resolveIfFixed()` helper
- [ ] `app/src/handlers/autofix.ts` — Same replacement
- [ ] `lib/src/utils/github.ts` — Verify `resolveReviewThread` mutation exists and works (it does — line ~1310)
- [ ] `app/src/handlers/autofix.ts` — Close linked issue on PR approval
- [ ] `.github/workflows/self-review.yml` `notify-merged` job — Also close linked issue via `gh issue close`
- [ ] Write tests for `getOpenHumanThreads()` in `lib/tests/github.test.ts`
- [ ] Write tests for the `resolveFixedComments()` helper

---

## Test Cases to Add

```ts
// lib/tests/github.test.ts

describe('getOpenHumanThreads', () => {
  it('returns empty string when no open human threads', async () => { ... });
  it('excludes bot-authored threads', async () => { ... });
  it('excludes resolved threads', async () => { ... });
  it('formats open human threads as markdown', async () => { ... });
});
```

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `resolveReviewThread` fails due to GraphQL permission (needs write access) | Fallback to `minimizeReviewComment('RESOLVED')` |
| Thread ID lookup is slow (extra GraphQL call per comment) | Batch: fetch all threads once, build a map by `databaseId`, reuse |
| Closing linked issue prematurely (PR not actually merged yet) | Only trigger on `pr.merged === true` event, not just approval label |
