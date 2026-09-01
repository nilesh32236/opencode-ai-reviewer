# Phase 5 — Additional Improvements & Recommendations

> **Severity:** Low–Medium (mix)  
> **Effort:** Varies per item — most are 1–4 hours each  
> **Dependencies:** Can be done in parallel with any other phase

---

## Overview

This phase collects everything else discovered during the full codebase audit: duplicated code, missing features, reliability gaps, DX improvements, and future ideas. Items are ordered from highest to lowest impact.

---

## Item 5.1 — Duplicate `buildReviewBody` / `buildFixBody` between action and app

**Severity:** Medium  
**File(s):** `action/src/fix.ts` and `app/src/handlers/autofix.ts`

**Problem:**  
Both files contain near-identical `buildReviewBody()`, `buildFixBody()`, and `buildReadyBody()` functions. They were copied and diverged slightly over time. `action/src/fix.ts` has a `'timeout'` status case and a `fixSummary` field in `buildFixBody` that the app path is missing.

**Fix:**  
Move all three functions to `lib/src/utils/autofix-body.ts`, export them from `lib/src/index.ts`, and import in both `action/src/fix.ts` and `app/src/handlers/autofix.ts`.

```ts
// lib/src/utils/autofix-body.ts
export function buildReviewBody(history, maxIterations, phase, current?) { ... }
export function buildFixBody(history) { ... }
export function buildReadyBody(history, prNumber) { ... }
```

This also ensures both paths stay in sync for future changes.

---

## Item 5.2 — `action` mode `analyze` missing from action dispatch

**Severity:** Medium  
**File(s):** `action/src/index.ts`

**Problem:**  
The `analyze` command exists in the Probot app (`handleAnalyzeCommand` in `commands.ts`) but is missing from the action's dispatch switch in `action/src/index.ts`. The `action.yml` lists `analyze` as a valid mode but nothing actually runs when you set `mode: analyze` in the action.

Looking at `action/src/index.ts`, the switch handles `review`, `fix`, `audit`, `post`, `pr-review` — but not `analyze`.

**Fix:**  
```ts
// action/src/index.ts
case 'analyze': {
  const { runAnalyzeIssue } = await import('./analyze.js');
  await runAnalyzeIssue(inputs, config, engine, gh);
  break;
}
```

`action/src/analyze.ts` already exists but is very minimal — expand it as part of Phase 3.

---

## Item 5.3 — `stuckReason` from fix agent never surfaced to the user

**Severity:** Medium  
**File(s):** `action/src/fix.ts`, `app/src/handlers/autofix.ts`

**Problem:**  
The fix agent can write `.fix-stuck.md` to signal it is stuck (e.g., cannot figure out how to fix something, needs clarification). The `FixResult` has `stuck: boolean` and `stuckReason?: string` fields. Neither the action path nor the app path surfaces this to the user in a comment.

Looking at `action/src/fix.ts → runAutofixLoop()`: `fixResult.stuck` and `fixResult.stuckReason` are never checked.

**Fix:**  
After calling `engine.runFix()`, check for stuck result and post a helpful comment:

```ts
if (fixResult.stuck) {
  const stuckBody = [
    '🛑 **Fix Agent Stuck**',
    '',
    fixResult.stuckReason || 'The fix agent could not determine how to address the remaining issues.',
    '',
    'Please provide additional context or manually apply the fix for the items listed above.',
  ].join('\n');

  await gh.postOrUpdateComment(prNumber, '<!-- autofix-stuck -->', stuckBody);
  logger.info(`Fix agent reported stuck — posted notice on PR #${prNumber}`);
  break; // Stop the loop — no point iterating if the agent is stuck
}
```

---

## Item 5.4 — Probot app does not subscribe to `issues.opened` for auto-analyze

**Severity:** Medium  
**File(s):** `app/src/index.ts`, `lib/src/event-bus/router.ts`

**Problem:**  
Covered in Phase 3 as a core feature, but flagged here as a separate reliability gap: the `EventRouter` in `lib/src/event-bus/router.ts` may not map `issues.opened` webhook events to the `issue.opened` GitHubEvent type. This needs to be verified and fixed.

**Fix:**  
Check `router.ts` for the `issues` event mapping and add `opened` action if missing. Also ensure the Probot `app.onAny()` handler correctly passes `issues` webhook payloads through the router.

---

## Item 5.5 — No close-on-merge for linked issues

**Severity:** Medium  
**File(s):** `.github/workflows/self-review.yml`, `app/src/handlers/autofix.ts`

**Problem:**  
When an autofix PR is merged (gets `autofix:merged` label), the linked issue is never automatically closed. The `notify-merged` job only posts a comment. The issue stays open until someone manually closes it.

**Fix — in the workflow:**
```yaml
notify-merged:
  steps:
    - name: Close linked issue
      env:
        GH_TOKEN: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
      run: |
        # Extract linked issue from PR body (Fixes #N pattern)
        LINKED=$(gh pr view "$PR_NUMBER" --json body --jq '.body' | grep -oP '(?<=Fixes #)\d+' | head -1)
        if [ -n "$LINKED" ]; then
          gh issue close "$LINKED" \
            --comment "✅ Resolved by PR #${PR_NUMBER} — merged to main." \
            --repo "${{ github.repository }}" || true
        fi
```

**Fix — in the app (when PR review loop approves):**  
Already covered in Phase 1, Step 4.

---

## Item 5.6 — `gatherContext()` does not include the analysis plan comment

**Severity:** Medium  
**File(s):** `lib/src/utils/github.ts → gatherContext()`

**Problem:**  
`gatherContext()` fetches issue comments and includes them in the context. However, bot comments are included raw without any special treatment for the `<!-- issue-analysis-plan -->` marker. The fix agent receives the full plan text buried inside a comments list, not as a clearly-labeled section.

**Fix:**  
In `gatherContext()`, detect the analysis plan comment and format it distinctly:

```ts
for (const c of issue.comments) {
  if (c.body.startsWith('<!-- issue-analysis-plan -->')) {
    // Extract and re-label the analysis plan prominently
    const planBody = c.body.replace('<!-- issue-analysis-plan -->\n\n', '');
    parts.push('### Implementation Plan (from analysis)');
    parts.push('');
    parts.push(planBody);
    parts.push('');
  } else if (!c.body.startsWith('<!--')) {
    // Skip other bot marker comments from context to reduce noise
    parts.push(`**@${c.author}** (${c.createdAt}):`);
    parts.push(c.body || '');
    parts.push('');
  }
}
```

---

## Item 5.7 — `fix-issue` workflow job has no `analysis:ready` gate

**Severity:** Medium  
**File(s):** `.github/workflows/self-review.yml`

**Problem:**  
The `fix-issue` job in `self-review.yml` triggers on `issue_comment` with `/fix` or `issues.labeled` with `autofix-trigger`. It does not check whether the analysis is complete or whether there are blocking questions (`analysis:needs-input` label).

**Fix:**  
Add a condition to the `fix-issue` job:

```yaml
fix-issue:
  if: |
    github.event.issue.pull_request == null && (
      (github.event_name == 'issue_comment' && contains(github.event.comment.body || '', '/fix'))
      ||
      (github.event_name == 'issues' && contains(github.event.issue.labels.*.name, 'autofix-trigger'))
    ) &&
    !contains(github.event.issue.labels.*.name, 'analysis:needs-input')
```

This prevents the fix from running when there are unanswered blocking questions. The action path will also check (Phase 3, Step 9), providing defense in depth.

---

## Item 5.8 — Review prompt doesn't include PR author context

**Severity:** Low  
**File(s):** `lib/src/prompts/builder.ts`

**Problem:**  
The review prompt includes changed files and diffs, but not the PR author's username. This matters for context — a first-time contributor's PR might warrant more gentle feedback; a known bot PR (like `self-improvement`) may need a different tone.

**Fix:**  
Pass `pr.author` into `buildReviewPrompt()` and include it in the context section:

```ts
// In review prompt:
`**PR Author:** ${prAuthor}${prAuthor.endsWith('[bot]') ? ' (automated/bot PR)' : ''}`
```

---

## Item 5.9 — Audit issues created without checking for existing duplicate issues

**Severity:** Low  
**File(s):** `action/src/audit.ts`, `lib/src/utils/github.ts`

**Problem:**  
Every time the daily audit runs, it creates new GitHub issues for findings. If the same finding was raised in a previous audit run and is still open, a duplicate issue is created.

**Fix:**  
Before creating an audit issue, search for an existing open issue with the same title:

```ts
async findExistingIssue(title: string): Promise<number | null> {
  const issues = await this.paginate<{ number: number; title: string; state: string }>(
    `/issues?state=open&labels=audit&per_page=100`
  );
  const match = issues.find(i => i.title === title);
  return match?.number ?? null;
}
```

In `audit.ts`, before `gh.createIssue(...)`:
```ts
const existing = await gh.findExistingIssue(issueTitle);
if (existing) {
  core.info(`Audit finding already has open issue #${existing} — skipping`);
  continue;
}
```

---

## Item 5.10 — No rate limit awareness in batch processing

**Severity:** Low  
**File(s):** `lib/src/engine.ts → reviewPR()`

**Problem:**  
The review engine runs multiple parallel sub-agent batches. When processing a large PR, all batches fire simultaneously, which can exhaust the GitHub API rate limit quickly if each batch makes multiple API calls.

**Fix:**  
Add a small delay between batch submissions (100–200ms) and respect the rate-limit header already tracked in `checkRateLimit()`:

```ts
// In reviewPR(), between batch submissions:
for (let batchIdx = 0; batchIdx < fileBatches.length; batchIdx++) {
  if (batchIdx > 0) {
    await new Promise(r => setTimeout(r, 150)); // Stagger batch start
  }
  // ... process batch
}
```

---

## Item 5.11 — Conversation handler context window: only 5 previous comments

**Severity:** Low  
**File(s):** `app/src/handlers/conversation.ts → gatherIssueCommentThread()`

**Problem:**  
The conversation thread only looks back 5 comments for context. For long PR discussions, important context from earlier in the thread is lost.

```ts
const contextStart = Math.max(0, triggerIdx - 5); // <-- only 5 comments back
```

**Fix:**  
Make this configurable via `config.conversation` and default to 10 (still bounded, but more context):

```ts
const contextWindow = config.conversation.contextWindow ?? 10;
const contextStart = Math.max(0, triggerIdx - contextWindow);
```

Add `contextWindow?: number` to the `ConversationConfig` type.

---

## Item 5.12 — Missing `issue_comment` event scope check in Probot subscribers

**Severity:** Low  
**File(s):** `app/src/index.ts` — `FixSubscriber`, `AnalyzeSubscriber`, `AuditSubscriber`

**Problem:**  
When a comment is posted on a PR (not an issue), GitHub sends both `comment.created` and `review_comment.created` events. But the `issue_comment` webhook also fires for regular issue comments. The current subscribers don't distinguish PR-comments from issue-comments — a `/fix` on a plain issue triggers the `FixSubscriber` which calls `handleCommand('fix', ...)`, which is correct. But a `/audit` on an issue also triggers the audit, which is probably not desired.

**Fix:**  
For audit, analyze, and other commands that should only run in a PR context, add a check:

```ts
const auditSubscriber = {
  async handle(event) {
    // ... existing check ...
    // Also ensure we're on a PR, not a plain issue
    const prNumber = event.prNumber || 0;
    if (prNumber && !(await gh.isPR(prNumber))) return;
    // ...
  }
}
```

---

## Item 5.13 — Self-improvement workflow uses `--auto` flag which may be deprecated

**Severity:** Low  
**File(s):** `.github/workflows/self-improvement.yml`

**Problem:**  
The self-improvement workflow runs:
```bash
opencode run --auto --model opencode/muse-spark-1.2-contributor-free "$(cat /tmp/self-improve-prompt.txt)"
```

The `--auto` flag behavior may change across OpenCode versions. The workflow doesn't pin the OpenCode version, so a breaking change in the CLI could silently break the self-improvement job.

**Fix:**  
Pin the OpenCode CLI version in the setup script. Add a version check at the start of the workflow:

```yaml
- name: Setup OpenCode
  run: |
    chmod +x .github/scripts/setup-opencode.sh
    .github/scripts/setup-opencode.sh
    opencode --version  # Log version for debugging
```

Also consider using a more stable invocation pattern and testing the workflow periodically.

---

## Item 5.14 — Test coverage gaps

**Severity:** Low  
**Areas to add tests:**

| File | Missing Tests |
|------|--------------|
| `app/src/handlers/commands.ts` | `handleAnalyzeCommand()`, `createAutofixPR()`, question-gate logic |
| `app/src/handlers/autofix.ts` | Loop iteration records, stuck handling, linked issue closure |
| `app/src/index.ts` | Subscriber routing (unit test each subscriber's filter logic) |
| `lib/src/utils/github.ts` | `getOpenHumanThreads()`, `updatePR()`, `findExistingIssue()` |
| `lib/src/utils/pr-body.ts` | (new) `buildAutofixPRBody()` — all branches |
| `lib/src/utils/autofix-body.ts` | (new after dedup) `buildReviewBody()`, all phase values |

---

## Item 5.15 — Future Feature: `/explain` on issues (not just PRs)

**Severity:** Low (future idea)  
**Current state:** `/explain` only works on PRs (calls `engine.runExplain(pr, ...)`).

**Idea:** Add `/explain` support for issues — generate a plain-English summary of the issue, proposed solution from the analysis plan, and complexity estimate. Useful for triaging.

---

## Item 5.16 — Future Feature: Review quality feedback loop

**Severity:** Low (future idea)  
**Current state:** The learning store records feedback signals (reactions, dismissals). But there's no UI for a developer to say "this issue was a false positive" directly from a review comment.

**Idea:** Add a `/oc false-positive` reply command on inline review comments. The bot records this, and the learning store updates the model's understanding of the project's conventions.

---

## Recommended Quick Wins (start here)

These items from Phase 5 can be done in a few hours each and have immediate user-visible impact:

1. **Item 5.3** — Surface `stuckReason` to the user (30 min)
2. **Item 5.2** — Add `analyze` dispatch to action (30 min)
3. **Item 5.1** — Deduplicate `buildReviewBody` / `buildFixBody` (2 hours)
4. **Item 5.5** — Close linked issue on merge (1 hour)
5. **Item 5.7** — Gate `fix-issue` job on `analysis:needs-input` label (30 min)
6. **Item 5.9** — Deduplicate audit issues (1 hour)

---

## Implementation Checklist

- [ ] 5.1: Move `buildReviewBody/buildFixBody/buildReadyBody` to `lib/src/utils/autofix-body.ts`
- [ ] 5.2: Add `analyze` case to `action/src/index.ts`
- [ ] 5.3: Check `fixResult.stuck` and post `<!-- autofix-stuck -->` comment
- [ ] 5.4: Verify `router.ts` maps `issues.opened` correctly
- [ ] 5.5: Close linked issue in `notify-merged` workflow job
- [ ] 5.6: Improve `gatherContext()` to label the analysis plan section distinctly
- [ ] 5.7: Add `analysis:needs-input` guard to `fix-issue` workflow job
- [ ] 5.8: Pass `pr.author` into review prompt
- [ ] 5.9: Check for duplicate open audit issues before creating new ones
- [ ] 5.10: Add inter-batch delay in `reviewPR()` to reduce rate-limit pressure
- [ ] 5.11: Make conversation context window configurable
- [ ] 5.12: Add PR-vs-issue scope checks in audit/analyze subscribers
- [ ] 5.13: Pin OpenCode CLI version in setup script
- [ ] 5.14: Fill test coverage gaps listed in the table above
