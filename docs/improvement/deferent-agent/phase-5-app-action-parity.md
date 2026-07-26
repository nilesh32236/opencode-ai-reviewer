# Phase 5 — App ↔ Action Parity: Converge the Two Code Paths

> **Goal:** Extract the duplicated autofix loop and issue-fix flow into shared modules in `lib/`, align the App's review path with the Action's (pass `previousBotComments`), delete the duplicate `action.yml` and `buildReviewBody`, and resolve the `max_lines_per_file` default mismatch.

This phase addresses **Findings F-8, F-9, F-13, F-14, F-15** from the master plan and is the largest refactor in this plan.

---

## 1. Background — what's wrong today

### 1.1 Two parallel code paths that should be one

The codebase has two runtime entry points: the **App** (`app/`, Probot server, runs on webhooks) and the **Action** (`action/`, GitHub Actions runner, runs on workflow invocation). Both call into `lib/` for the engine, prompts, GitHub utilities, and learning store.

But the autofix loop is duplicated:

- **App:** `app/src/handlers/autofix.ts` (entire file, ~120 lines) and `app/src/handlers/commands.ts:createAutofixPR` (lines 249-418).
- **Action:** `action/src/fix.ts:runAutofixLoop` (lines 432-710) and `action/src/fix.ts:runFixIssue` (lines 144-309).

The two implementations are ~80% identical but with subtle divergences:

| Behavior | App | Action |
|---|---|---|
| Minimizes stale comments | ❌ No | ✅ Yes (`fix.ts:549-573`) |
| Tracks `previousFindings` across iterations | ❌ No | ✅ Yes |
| Calls `resolveReviewThread` | ❌ No | ❌ No (but Phase 1 adds it to both) |
| Question gating (Phase 3) | ❌ Not yet | ❌ Not yet |
| PR body from `fixResult.summary` (Phase 3) | ❌ Not yet | ❌ Not yet |
| Timeout handling | ❌ Basic | ✅ Per-iteration |
| Token usage tracking | ❌ No | ✅ Yes (telemetry spec) |

Every new feature added in Phases 1–4 has to be implemented twice. Phase 5 collapses them into one.

### 1.2 App review path doesn't pass `previousBotComments`

The Action's review path (`action/src/review.ts:69-95`) fetches `getBotReviewThreads` and passes `previousBotComments` to `engine.reviewPR`. The LLM is told what it previously reported, so it can mark persisting issues with `previouslyReported: true`.

The App's review path (`app/src/handlers/pr-review.ts:52-62`) calls `engine.reviewPR(pr, undefined, undefined, undefined, undefined, undefined, reviewWorkingDir, previousHeadSha)` — the 9th parameter `previousBotComments` is **not passed**. So on every `pr.synchronize`, the App re-reports everything from scratch, including issues it already raised that are still open. This produces **duplicate review comments on every push**.

This is **Finding F-8**. It's a one-line fix once identified, but it has been causing duplicate comments for the entire history of the App.

### 1.3 Two `buildReviewBody` implementations

- `lib/src/jsonl-parser.ts:285-321` — uses `> Suggestion: ${i.suggestion}` formatting.
- `lib/src/utils/github.ts:1398-1452` — uses `> ${i.suggestion}` formatting (no "Suggestion:" prefix).

Both exist, both are called. Subtle visual differences depending on which code path runs. This is **Finding F-13**.

### 1.4 Two `action.yml` files with drift

- Top-level `action.yml` — older, missing `review_inline`, `enable_state_cache`, `state_cache_key` inputs.
- `action/action.yml` — newer, has all the inputs.

Workflows that reference the action via the top-level path silently ignore the newer inputs. This is **Finding F-14**.

### 1.5 `max_lines_per_file` default mismatch

- `lib/src/types/index.ts:744` `DEFAULT_CONFIG.maxLinesPerFile` → `200`.
- `action/action.yml` → `500`.
- `action/src/inputs.ts:112` parses with default `500`.

The effective value depends on which path sets it. This is **Finding F-15**.

---

## 2. Design — one shared autofix loop, one shared review path

### 2.1 The shared autofix loop

A new module `lib/src/autofix/loop.ts` exports a single function:

```ts
export interface AutofixLoopOptions {
  // Environment
  gh: GitHubHelper;
  engine: ReviewEngine;
  store: LearningStore;
  logger: Logger;
  workingDir: string;
  config: AgentConfig;

  // Target
  pr: PRContext;                    // for PR-mode autofix
  previousHeadSha?: string;

  // State
  previousFindings?: PreviousIteration[];

  // Phase 3 additions
  issueContext?: { issueNumber: number; repo: string; };  // for issue-mode
  plan?: AnalyzeResult;
  answeredQuestions?: IssueQuestion[];

  // Phase 4 additions
  options?: CommandOptions;          // { force, dryRun, triggeredBy }
}

export async function runAutofixLoop(opts: AutofixLoopOptions): Promise<AutofixLoopResult>;
```

The function contains the entire loop:

1. For each iteration (up to `config.maxIterations`):
   a. Run `engine.reviewPR` with `previousBotComments` and `previousFindings`.
   b. If `result.verdict.ready` and no critical issues → break.
   c. **Phase 1:** Run `verifyResolution` on previous findings.
   d. If `result.issues.length === 0` → break.
   e. Run `engine.runFix` with the issues.
   f. Apply the fix to the working dir.
   g. Run any configured post-fix checks.
   h. Commit and push.
   i. Record `previousFindings` for the next iteration.
2. Return the final state.

The App and Action wrappers become:

```ts
// app/src/handlers/autofix.ts (after Phase 5)
import { runAutofixLoop } from '@opencode-pr-agent/lib';

export async function handleAutofixLoop(pr: PRContext, ...) {
  const opts = await buildAppOptions(pr, ...);  // environment-specific setup
  return runAutofixLoop(opts);
}
```

```ts
// action/src/fix.ts:runAutofixLoop (after Phase 5)
import { runAutofixLoop } from '@opencode-pr-agent/lib';

export async function runAutofixLoop(actionInputs: ActionInputs, ...) {
  const opts = await buildActionOptions(actionInputs, ...);
  return runAutofixLoop(opts);
}
```

The environment-specific bits (workspace setup, token acquisition, git config) stay in the wrappers. The loop logic is shared.

### 2.2 The shared issue-fix flow

Same pattern for `createAutofixPR` (App) and `runFixIssue` (Action):

```ts
// lib/src/autofix/issue-fix.ts
export interface IssueFixOptions {
  gh: GitHubHelper;
  engine: ReviewEngine;
  store: LearningStore;
  logger: Logger;
  workingDir: string;
  config: AgentConfig;

  issueNumber: number;
  repo: string;
  options?: CommandOptions;  // force, dryRun, triggeredBy
}

export async function runIssueFix(opts: IssueFixOptions): Promise<IssueFixResult>;
```

This function contains:

1. Ensure a plan exists (call `handleAnalyzeCommand` if not).
2. **Phase 3:** Question gating.
3. Run `engine.runFix` with the structured plan and answered questions.
4. **Phase 3:** Build the PR body from `fixResult.summary`.
5. Create the branch, commit, push, open the PR.

### 2.3 The shared review path

`app/src/handlers/pr-review.ts` is updated to mirror `action/src/review.ts`:

```ts
export async function handlePRReview(pr: PRContext, ...) {
  const gh = new GitHubHelper(...);
  const previousBotComments = await gh.getBotReviewThreads(pr.number)
    .then(threads => threads.filter(t => t.firstComment).map(t => ({
      file: t.firstComment!.filePath,
      line: t.firstComment!.lineNumber,
      body: t.firstComment!.body,
      commentId: t.firstComment!.databaseId,
      nodeId: t.firstComment!.id,
      threadId: t.id,
    })));

  const result = await engine.reviewPR(
    pr,
    undefined,                       // file batch
    undefined,                       // audit prompt
    undefined,                       // extra instructions
    undefined,                       // previousFindings (only set in autofix loop)
    previousBotComments,             // ← FIX: was being omitted
    reviewWorkingDir,
    previousHeadSha,
  );
  // ...
}
```

This is the one-line fix (well, several-line) for **Finding F-8**.

### 2.4 Consolidate `buildReviewBody`

Pick one (the `github.ts` version, since it's used by the App and is the more recent). Delete the other. Update callers in `lib/src/jsonl-parser.ts` to delegate to `github.ts`'s version (or inline the call).

Specifically:

- Delete `buildReviewBody` from `lib/src/jsonl-parser.ts:285-321`.
- Update any caller of `jsonl-parser.buildReviewBody` to call `GitHubHelper.buildReviewBody` instead (or extract it as a standalone function in a new `lib/src/utils/review-body.ts` if it shouldn't be a method on `GitHubHelper`).
- Normalize the formatting: pick one (`> Suggestion: ...` or just `> ...`) and use it everywhere.

### 2.5 Delete the duplicate `action.yml`

The top-level `action.yml` is a stale duplicate of `action/action.yml`. Steps:

1. Verify no workflows in the repo reference the action via the top-level path. (Check `.github/workflows/*.yml` and `examples/`.)
2. Update any references to point at `action/action.yml`.
3. Delete `action.yml` (top-level).
4. Update `README.md` installation instructions if they reference the top-level path.

If the action is published to the GitHub Marketplace, the marketplace entry points at the top-level `action.yml` — in that case, instead of deleting, sync the top-level `action.yml` with `action/action.yml` and add a CI check that they stay in sync (or generate one from the other).

### 2.6 Align `max_lines_per_file` default

Pick one: `200` (the lib default, more conservative) or `500` (the action default, more generous). Recommendation: `200`, because the lib default is what the App uses, and the App is the more common deployment.

Update `action/action.yml` and `action/src/inputs.ts:112` to default to `200`. Update the existing `examples/` workflows if they rely on `500`.

### 2.7 Type the webhook payloads

Currently every subscriber in `app/src/index.ts` does `event.payload as Record<string, unknown>` and walks nested fields with `?.`. The Probot library ships typed payloads. Adopting them:

```ts
import { PullRequestEvent, IssueCommentEvent } from '@octokit/webhooks-types';

class FixSubscriber {
  async handle(event: { payload: IssueCommentEvent | PullRequestEvent }) {
    const payload = event.payload;
    if ('comment' in payload) {
      const body = payload.comment.body;
      // ...
    }
  }
}
```

This is a large mechanical refactor. Land it as the **last** PR in Phase 5 so it doesn't conflict with the other Phase 5 work.

---

## 3. File-by-file changes

### 3.1 `lib/src/autofix/loop.ts` (NEW)

The shared `runAutofixLoop(opts)` function. ~300 lines, containing the entire loop logic with Phase 1 (verifyResolution) and Phase 3 (gate, PR body) integrated.

### 3.2 `lib/src/autofix/issue-fix.ts` (NEW)

The shared `runIssueFix(opts)` function. ~150 lines, containing the issue-fix flow with Phase 3 (gate, PR body) integrated.

### 3.3 `lib/src/autofix/types.ts` (NEW)

Shared types: `AutofixLoopOptions`, `AutofixLoopResult`, `IssueFixOptions`, `IssueFixResult`, `PreviousIteration`, `CommandOptions`.

### 3.4 `app/src/handlers/autofix.ts` (MODIFY — drastic shrink)

Becomes a thin wrapper:

```ts
import { runAutofixLoop } from '@opencode-pr-agent/lib';

export async function handleAutofixLoop(pr: PRContext, config: AgentConfig, signal?: AbortSignal) {
  const opts = await buildAppAutofixOptions(pr, config, signal);
  return runAutofixLoop(opts);
}

async function buildAppAutofixOptions(pr, config, signal): Promise<AutofixLoopOptions> {
  // App-specific: workspace setup, token acquisition, git config
  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-workspace-'));
  const token = getToken();
  const gh = new GitHubHelper(token, pr.head.repo.owner.login, pr.head.repo.name);
  await configureGit(workingDir, token);
  await gh.cloneRepo(workingDir, pr.head.ref);
  // ...
  return { gh, engine, store, logger, workingDir, config, pr, options: { signal } };
}
```

The file shrinks from ~120 lines to ~30.

### 3.5 `app/src/handlers/commands.ts` (MODIFY)

`createAutofixPR` becomes a thin wrapper around `runIssueFix`:

```ts
import { runIssueFix } from '@opencode-pr-agent/lib';

export async function createAutofixPR(issueNumber, repo, config, options) {
  const opts = await buildAppIssueFixOptions(issueNumber, repo, config, options);
  return runIssueFix(opts);
}
```

### 3.6 `action/src/fix.ts` (MODIFY — drastic shrink)

`runAutofixLoop` and `runFixIssue` become thin wrappers, same as the App. The file shrinks substantially.

### 3.7 `app/src/handlers/pr-review.ts` (MODIFY)

Add the `previousBotComments` fetch and pass it to `engine.reviewPR`. (The one-line fix for F-8.)

### 3.8 `lib/src/jsonl-parser.ts` (MODIFY)

Delete `buildReviewBody` (lines 285-321). Update callers to use the shared `buildReviewBody` from `lib/src/utils/review-body.ts` (new file) or from `GitHubHelper`.

### 3.9 `lib/src/utils/review-body.ts` (NEW)

A standalone `buildReviewBody(findings, options)` function. Extracted from `GitHubHelper.buildReviewBody` so it can be called without a `GitHubHelper` instance (useful in tests).

### 3.10 `lib/src/utils/github.ts` (MODIFY)

`buildReviewBody` either becomes a method wrapper around the standalone function, or is removed (callers use the standalone). Pick one and be consistent.

### 3.11 `action.yml` (DELETE or SYNC)

Either delete (if not referenced by marketplace) or sync with `action/action.yml` and add a CI check.

### 3.12 `action/action.yml` (MODIFY)

Change `max_lines_per_file` default from `500` to `200`.

### 3.13 `action/src/inputs.ts` (MODIFY)

Change `max_lines_per_file` default from `500` to `200`.

### 3.14 `lib/src/types/index.ts` (MODIFY)

Confirm `DEFAULT_CONFIG.maxLinesPerFile` is `200`. Add the `CommandOptions` type if not already present (Phase 4 may have added it).

### 3.15 `app/src/index.ts` (MODIFY — typed payloads)

Replace `event.payload as Record<string, unknown>` with typed payload imports from `@octokit/webhooks-types`. Mechanical but touches every subscriber.

### 3.16 `.github/workflows/*.yml` (MODIFY)

Update any workflow that references the action via the top-level `action.yml` path. Update `examples/*.yml` similarly.

---

## 4. Tests

### 4.1 `lib/tests/autofix-loop.test.ts` (NEW — major test suite)

This is the test suite that pins the shared loop. It covers all the scenarios from Phase 1's §4.4 and Phase 3's §4.3, but now against the shared function. Scenarios:

- Loop terminates when `verdict.ready` is true.
- Loop terminates when no issues are found.
- Loop runs up to `maxIterations` if issues persist.
- Each iteration calls `verifyResolution` (Phase 1) on previous findings.
- Each iteration calls `runFix` with the current issues.
- Each iteration commits and pushes.
- `previousFindings` is updated between iterations.
- `previousBotComments` is passed to `engine.reviewPR`.
- Question gating (Phase 3) blocks the loop on the first iteration if open required questions exist.
- `--force` bypasses the gate.
- `--dry-run` runs the first iteration's review but does not commit or push.
- Token usage is recorded per iteration.

### 4.2 `lib/tests/issue-fix.test.ts` (NEW)

Tests for `runIssueFix`:

- Ensures a plan exists before fixing.
- Gates on required questions.
- Builds the PR body from `fixResult.summary`.
- Creates the branch, commits, pushes, opens the PR.
- `--force` bypasses the gate.
- `--dry-run` posts the dry-run comment and does not push.

### 4.3 `lib/tests/review-body.test.ts` (NEW)

Tests for the consolidated `buildReviewBody`:

- Renders findings with and without suggestions.
- Renders the suggestion as `> Suggestion: ...` consistently (no more format divergence).
- Handles empty findings list.

### 4.4 `lib/tests/pr-review.test.ts` (NEW)

Tests for the App's `handlePRReview`:

- Fetches `getBotReviewThreads` and passes them to `engine.reviewPR` as `previousBotComments`. (This is the regression test for F-8 — would have caught the original bug.)
- Handles the case where `getBotReviewThreads` returns empty.
- Handles `pr.synchronize` with `previousHeadSha`.

### 4.5 Existing tests — verify no regression

Run the full `lib/tests/` suite. All tests that previously passed against the App's `autofix.ts` and the Action's `fix.ts` should still pass against the shared `runAutofixLoop`. Some tests may need to be updated to call the shared function instead of the per-runtime one — that's expected.

---

## 5. Acceptance Criteria

- [ ] `lib/src/autofix/loop.ts` exists and exports `runAutofixLoop`.
- [ ] `lib/src/autofix/issue-fix.ts` exists and exports `runIssueFix`.
- [ ] `lib/src/autofix/types.ts` exists with the shared option/result types.
- [ ] `app/src/handlers/autofix.ts` is a thin wrapper (≤30 lines).
- [ ] `app/src/handlers/commands.ts:createAutofixPR` is a thin wrapper.
- [ ] `action/src/fix.ts:runAutofixLoop` and `runFixIssue` are thin wrappers.
- [ ] `app/src/handlers/pr-review.ts` fetches `previousBotComments` and passes them to `engine.reviewPR`.
- [ ] `lib/src/jsonl-parser.ts:buildReviewBody` is deleted.
- [ ] `lib/src/utils/review-body.ts` exists and is the single source of truth.
- [ ] `action.yml` (top-level) is either deleted or synced with `action/action.yml`, with a CI check.
- [ ] `max_lines_per_file` default is `200` everywhere.
- [ ] All webhook payload types in `app/src/index.ts` use `@octokit/webhooks-types`.
- [ ] All test scenarios in §4 pass.
- [ ] No regression in existing `lib/tests/` suite.

---

## 6. Rollout Steps

This is the largest phase. Break it into many small PRs.

1. **PR-5.1 — `previousBotComments` fix in App review:** Update `app/src/handlers/pr-review.ts`. Add regression test. This is a one-day fix that immediately stops duplicate comments on `pr.synchronize`. Ship first.
2. **PR-5.2 — Consolidate `buildReviewBody`:** Extract to `lib/src/utils/review-body.ts`. Delete from `jsonl-parser.ts`. Update callers. Test.
3. **PR-5.3 — `max_lines_per_file` default alignment:** Change `action.yml` and `inputs.ts` defaults to `200`. Update `examples/`. Test.
4. **PR-5.4 — Sync `action.yml`:** Either delete the top-level or sync with `action/action.yml`. Add a CI check that diffs them. Test.
5. **PR-5.5 — Extract `runAutofixLoop` to `lib/`:** Create `lib/src/autofix/loop.ts` with the shared function. The function should produce identical behavior to the existing `action/src/fix.ts:runAutofixLoop`. Update the Action to call it. The App still uses its own loop (for now). Test extensively.
6. **PR-5.6 — Switch App to shared `runAutofixLoop`:** Update `app/src/handlers/autofix.ts` to call the shared function. Delete the App's loop logic. Test.
7. **PR-5.7 — Extract `runIssueFix` to `lib/`:** Same pattern as 5.5 but for the issue-fix flow. Test.
8. **PR-5.8 — Switch App and Action to shared `runIssueFix`:** Update both wrappers. Test.
9. **PR-5.9 — Typed webhook payloads:** Mechanical refactor across `app/src/index.ts`. Test.

PRs 5.1, 5.2, 5.3, 5.4 are independent and can land in parallel. PR 5.5 depends on Phase 1, 2, 3 being merged (so the shared loop includes the new logic). PR 5.6 depends on 5.5. PR 5.7 depends on 5.5. PR 5.8 depends on 5.7. PR 5.9 is independent of 5.5–5.8 but conflicts with everything in `app/src/index.ts`, so land it last.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Shared `runAutofixLoop` has a subtle behavior difference from the App's loop that breaks existing users | Medium | High | PR 5.5 ships with the Action calling the shared function, while the App keeps its own loop. Run both in parallel for one release cycle. Compare behavior on a staging repo. Only switch the App (PR 5.6) when confident. |
| `previousBotComments` fix causes the App's review prompt to grow too large (it now includes all prior comments) | Low | Medium | The prompt already truncates `previousBotComments` to first 200 chars per comment (`builder.ts:240-255`). If PRs have hundreds of bot comments, add a cap (e.g. last 50 comments). |
| Deleting top-level `action.yml` breaks marketplace users | Medium | High | Check the marketplace listing first. If the marketplace uses the top-level path, sync instead of delete. Add a CI check that the two files are identical. |
| Typed webhook payloads refactor introduces runtime crashes on edge cases | Medium | Medium | Land it last (PR 5.9). Add exhaustive type tests. Keep the `as Record<string, unknown>` fallback in a `try/catch` for the first release. |
| `max_lines_per_file` change from 500 to 200 breaks users who relied on 500 | Low | Low | The default is overridable via config. Document the change in the changelog. |
| The shared `runAutofixLoop` is harder to debug because the wrapper is thin | Low | Low | The shared function takes a `logger` and logs every step. The wrapper logs environment-specific setup. The audit trail (`comment_actions`, `fix_overrides`) covers the rest. |

---

## 8. Open Questions

1. **Should the shared `runAutofixLoop` live in `lib/src/autofix/` or `lib/src/engine.ts`?** Recommendation: `lib/src/autofix/` as a separate module. `engine.ts` is already large (~1300 lines). The autofix loop is a higher-level orchestration that uses the engine; it deserves its own module.

2. **Should the App and Action wrappers share a common base, or stay separate?** Recommendation: separate. The environment setup (workspace, token, git config) is genuinely different. The wrappers should be small and obvious.

3. **Should the typed webhook payloads refactor also type the event router?** Recommendation: yes, but as a follow-up (Phase 6 or a separate PR). The event router at `lib/src/event-bus/router.ts` currently uses string-typed event names. Typing them as a union of Probot's known event types would be a nice safety improvement.

4. **Should the shared `runAutofixLoop` support a "headless" mode for testing (no git, no PR)?** Recommendation: yes. Inject `gh` and `engine` as dependencies (already the case). Tests inject mocks. No special "headless" mode needed.

5. **Should the `action.yml` sync CI check be a pre-commit hook or a GitHub Actions workflow?** Recommendation: GitHub Actions workflow. Pre-commit hooks are easy to skip; a CI check is enforceable.

---

End of Phase 5. Continue to `phase-6-additional-improvements.md`.
