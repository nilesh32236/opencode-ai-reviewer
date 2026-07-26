# Phase 6 — Additional Improvements: Tests, Observability, Docs, Cleanup

> **Goal:** Add the regression tests that should have existed all along, add observability tooling (a `/why` command for comment audit trails), document the new architecture, clean up code smells, and add the small polish items surfaced during the audit.

This phase addresses **Findings F-16, F-17, F-18** and the cross-cutting recommendations from the master plan.

---

## 1. Background — what's missing today

### 1.1 Test coverage gaps

The repo has a solid test suite (`lib/tests/`), but several critical workflows are undertested:

- **No test for the analyze→fix round-trip.** A regression test here would have caught the PR-body-copy-paste bug (Phase 3's F-1) and the no-question-gating bug (Phase 3's F-2) before they shipped.
- **No test for `verifyResolution`** — being added in Phase 1.
- **No test for the question gate** — being added in Phase 3.
- **No test for `previousBotComments` propagation in the App's review path** — being added in Phase 5.
- **No integration test for the autofix loop end-to-end.** Phase 5 adds one, but only after the consolidation. Phase 6 adds integration tests for the App's webhook subscribers specifically.

### 1.2 No observability for comment actions

When the bot minimizes, resolves, or un-minimizes a comment, there's no way for the maintainer to find out **why** after the fact. Phase 1 adds the `comment_actions` audit trail table, but there's no UI to query it. A `/why <comment-url>` slash command would close the loop.

### 1.3 Documentation drift

- `README.md` doesn't mention the analyze/fix/audit commands' full behavior.
- `docs/superpowers/specs/` has three design specs, but no spec for the Phase 1–5 changes.
- The App-vs-Action architecture is not documented anywhere a new contributor would find it.
- The `agent.md` file (root) is sparse.

### 1.4 Code smells

- Empty JSDoc stubs throughout `lib/` (Finding F-17). They look like skeletons that were never filled in.
- `detectLibrariesFromDir` in `lib/src/engine.ts:1217-1265` has hard-coded PHP/WordPress path heuristics (Finding F-18).
- `Record<string, unknown>` casts for webhook payloads throughout `app/src/index.ts` (Phase 5 fixes this).
- The `commandTriggers` config key (`lib/src/types/index.ts:749`) is declared but largely unused — the actual command matching is hard-coded per subscriber. Phase 4 makes it usable.

---

## 2. Design — six workstreams

### 2.1 Workstream A: Regression test suite

Add tests that pin the **end-to-end** behavior of the bot, not just unit-level functions. These tests should:

- Use a mock GitHub API (the existing tests use `lib/tests/github.test.ts` mocks — extend that pattern).
- Use a mock OpenCode CLI runner (the existing tests mock `runOpenCode` — extend that).
- Run the full webhook→subscriber→engine→GitHub-mutation flow.

Specific tests to add:

- `lib/tests/e2e/analyze-to-fix.test.ts` — Full flow: issue opened → auto-analyze → maintainer answers question → `/fix` → PR opened. Asserts: plan comment posted, questions comment posted, question marked answered, gate passed, PR body uses `fixResult.summary`.
- `lib/tests/e2e/review-resolve.test.ts` — Full flow: PR opened → review posts comment → maintainer pushes fix → second review → `verifyResolution` classifies as FIXED → `resolveReviewThread` called.
- `lib/tests/e2e/review-still-present.test.ts` — Same as above but the fix doesn't actually address the issue → `verifyResolution` classifies as STILL_PRESENT → comment stays visible, issue re-tagged with `previouslyReported: true`.
- `lib/tests/e2e/command-false-trigger.test.ts` — Comments like "what's the fix?" don't trigger `/fix`. (Regression test for Phase 4.)
- `lib/tests/e2e/pr-vs-issue-fix.test.ts` — `/fix` on a PR runs the autofix loop, doesn't create a recursive PR. (Regression test for Phase 4.)

### 2.2 Workstream B: `/why` observability command

A new slash command `/why <comment-url>` that:

1. Parses the comment URL to extract `(owner, repo, pr_number, comment_id)`.
2. Queries the `comment_actions` table (Phase 1) for all rows with that `comment_id`.
3. Posts a comment summarizing the audit trail:

```markdown
<!-- why-audit -->

📋 **Audit trail for comment [#1234](url)**

| Timestamp | Action | Reason |
|---|---|---|
| 2026-07-26 10:00 | posted | Initial review finding |
| 2026-07-26 10:15 | resolved | FIXED: commit abc123 replaced string concatenation with parameterized query |
| 2026-07-26 10:20 | unresolved | (manual) Maintainer re-opened the thread |

_Learn more: [comment_actions documentation](link)_
```

If no audit trail exists (e.g. the comment was posted before Phase 1 shipped), post a friendly "no audit trail available for this comment" message.

A related command `/why plan <issue-url>` shows the audit trail for an issue's analysis plan: when it was generated, when questions were asked, when they were answered, by whom.

### 2.3 Workstream C: Documentation

- **`docs/architecture.md` (NEW):** Documents the App-vs-Action architecture, the event flow, the shared `lib/` modules, and the new verify→resolve→collapse flow from Phase 1. Includes diagrams (Mermaid).
- **`docs/commands.md` (NEW):** Reference for every slash command, with usage examples, flags, and config overrides. Generated from a single source of truth (the `parseCommand` patterns from Phase 4) so it can't drift.
- **`README.md` (MODIFY):** Add a "Commands" section linking to `docs/commands.md`. Add a "How review resolution works" section explaining the verify→resolve→collapse flow. Add a "Configuration" section listing the new config keys from Phases 1–4.
- **`CHANGELOG.md` (MODIFY):** One entry per phase, with the user-visible changes called out.
- **`docs/superpowers/specs/2026-07-26-verify-resolve-collapse-design.md` (NEW):** Spec for the Phase 1 changes, following the existing spec format.
- **`docs/superpowers/specs/2026-07-26-issue-analysis-q-and-a-design.md` (NEW):** Spec for the Phase 2 changes.
- **`docs/superpowers/specs/2026-07-26-autofix-gating-design.md` (NEW):** Spec for the Phase 3 changes.
- **`agent.md` (MODIFY):** Update with the new commands and the new architecture summary.

### 2.4 Workstream D: Code cleanup

- **Empty JSDoc stubs:** Either fill them in or delete them. Add a lint rule (`eslint-plugin-jsdoc` with `require-jsdoc` and `no-empty-jsdoc`) to prevent recurrence.
- **`detectLibrariesFromDir` heuristics:** Replace the hard-coded PHP/WordPress patterns (`lib/src/engine.ts:1217-1265`) with a config-driven `libraryDetection.patterns` array. Default config includes the existing patterns; users can override.
- **`stubPR` rename:** Rename the misleading `stubPR` variable in `app/src/handlers/commands.ts:323` to `syntheticPR` or `issuePRContext`.
- **`commandTriggers` config:** Either wire it up (so it actually controls command matching) or delete it. Phase 4's `review.commandPrefix` is the wired-up version; the old `commandTriggers` should be removed with a migration path.

### 2.5 Workstream E: Performance and cost guardrails

- **Per-issue context window budget:** Today `gatherContext` fetches the entire issue body + all comments and jams it into the prompt. On long threads (50+ comments), this can blow the context window. Add a summarization pass: if the gathered context exceeds N tokens, summarize older comments into a single "previous discussion summary" line. The bot's own comments (plan, questions, etc.) are preserved verbatim; only maintainer comments get summarized.
- **Verifier call parallelism (Phase 1):** Parallelize `verifyResolution` calls across findings with a concurrency limit of 5.
- **Token budget per autofix iteration:** Add a config `fix.maxTokensPerIteration` (default: 100000). If an iteration exceeds the budget, abort with a clear error comment rather than silently burning tokens.
- **Token usage surface in PR body (Phase 3):** Already planned. Phase 6 adds it to the GitHub Step Summary for the Action path.

### 2.6 Workstream F: Polish commands

- **`/fix --dry-run`:** Already added in Phase 4. Phase 6 adds the same flag to `/audit`.
- **`/reconcile-comments`:** Already added in Phase 1. Phase 6 adds a `--all` flag that scans all open PRs in the repo (admin-only).
- **`/overrides`:** Lists recent `fix_overrides` rows for the repo. Useful for admins auditing `--force` usage.
- **`/discover`:** Already added in Phase 4. Phase 6 adds a `--since=<date>` flag to filter patterns by recency.
- **`/help`:** New command that posts a one-page summary of all available commands with links to `docs/commands.md`. Useful for new maintainers.

---

## 3. File-by-file changes

### 3.1 Tests (Workstream A)

- `lib/tests/e2e/analyze-to-fix.test.ts` (NEW)
- `lib/tests/e2e/review-resolve.test.ts` (NEW)
- `lib/tests/e2e/review-still-present.test.ts` (NEW)
- `lib/tests/e2e/command-false-trigger.test.ts` (NEW)
- `lib/tests/e2e/pr-vs-issue-fix.test.ts` (NEW)
- `lib/tests/e2e/helpers/` (NEW) — shared mock helpers for GitHub API, OpenCode CLI, LearningStore.

### 3.2 `/why` command (Workstream B)

- `app/src/handlers/commands.ts` (MODIFY) — add `handleWhyCommand`.
- `lib/src/learning/store.ts` (MODIFY) — add `getCommentActions(commentId)`, `getPlanHistory(issueNumber)`.
- `lib/src/utils/comment-url.ts` (NEW) — parses a GitHub comment URL into `(owner, repo, pr_number, comment_id)`.

### 3.3 Documentation (Workstream C)

- `docs/architecture.md` (NEW)
- `docs/commands.md` (NEW)
- `README.md` (MODIFY)
- `CHANGELOG.md` (MODIFY)
- `docs/superpowers/specs/2026-07-26-verify-resolve-collapse-design.md` (NEW)
- `docs/superpowers/specs/2026-07-26-issue-analysis-q-and-a-design.md` (NEW)
- `docs/superpowers/specs/2026-07-26-autofix-gating-design.md` (NEW)
- `agent.md` (MODIFY)

### 3.4 Code cleanup (Workstream D)

- `lib/src/engine.ts` (MODIFY) — refactor `detectLibrariesFromDir` to be config-driven.
- `lib/src/types/index.ts` (MODIFY) — add `libraryDetection.patterns` config.
- `app/src/handlers/commands.ts` (MODIFY) — rename `stubPR`.
- `eslint.config.mjs` (MODIFY) — add `eslint-plugin-jsdoc` rules.
- Many files (MODIFY) — fill in or delete empty JSDoc stubs.
- `lib/src/types/index.ts` (MODIFY) — remove `commandTriggers` (deprecated by Phase 4's `commandPrefix`).

### 3.5 Performance (Workstream E)

- `lib/src/utils/github.ts` (MODIFY) — `gatherContext` adds a summarization pass when context exceeds N tokens.
- `lib/src/prompts/summarize-thread.ts` (NEW) — prompt for summarizing old comments.
- `lib/src/types/index.ts` (MODIFY) — add `fix.maxTokensPerIteration`, `review.contextWindowBudget`.
- `lib/src/engine.ts` (MODIFY) — enforce token budget per iteration.

### 3.6 Polish commands (Workstream F)

- `app/src/handlers/commands.ts` (MODIFY) — add `handleHelpCommand`, `handleOverridesCommand`, `--all` for reconcile, `--since` for discover.
- `lib/src/utils/command-match.ts` (MODIFY) — add `help`, `overrides` to `COMMAND_PATTERNS`.

---

## 4. Tests

### 4.1 E2E tests (Workstream A)

Each e2e test follows the pattern:

1. Set up a mock GitHub API with a fixture (issue body, PR diff, existing comments).
2. Set up a mock OpenCode CLI that returns canned JSONL.
3. Set up an in-memory LearningStore.
4. Dispatch a webhook event.
5. Assert the GitHub mutations (comments posted, threads resolved, PRs opened) match expectations.
6. Assert the LearningStore state (questions recorded, audit trail logged).

### 4.2 `/why` tests

- `/why https://github.com/owner/repo/pull/42#discussion_r1234` → parses URL, queries audit trail, posts summary.
- `/why plan https://github.com/owner/repo/issues/42` → queries plan history, posts summary.
- `/why` with no URL → posts usage hint.
- `/why <invalid-url>` → posts error.
- `/why <comment-with-no-trail>` → posts "no audit trail available".

### 4.3 Documentation tests

- `docs/commands.md` is generated from `parseCommand` patterns — add a CI check that regenerates the file and fails if it's out of sync.
- `docs/architecture.md` includes Mermaid diagrams — add a CI check that the diagrams render.

### 4.4 Code cleanup tests

- `detectLibrariesFromDir` with default config → same behavior as before.
- `detectLibrariesFromDir` with custom `libraryDetection.patterns` → uses custom patterns.
- ESLint runs cleanly on all `lib/` files.

### 4.5 Performance tests

- `gatherContext` with 5 comments → no summarization (under budget).
- `gatherContext` with 50 comments → summarization kicks in, bot's own comments preserved verbatim, maintainer comments summarized.
- Autofix iteration that exceeds `maxTokensPerIteration` → aborts with clear error comment.

---

## 5. Acceptance Criteria

### Workstream A (Tests)
- [ ] All five e2e test files exist and pass.
- [ ] E2E helpers are extracted to `lib/tests/e2e/helpers/`.
- [ ] E2E tests run in CI (under 60 seconds total).

### Workstream B (`/why`)
- [ ] `handleWhyCommand` exists and is test-covered.
- [ ] `getCommentActions` and `getPlanHistory` exist on `LearningStore`.
- [ ] `comment-url.ts` parser is test-covered.
- [ ] `/why` is registered as a slash command.

### Workstream C (Docs)
- [ ] `docs/architecture.md` exists with Mermaid diagrams.
- [ ] `docs/commands.md` exists and is auto-generated from `parseCommand`.
- [ ] `README.md` has the new sections.
- [ ] Three new spec files exist in `docs/superpowers/specs/`.
- [ ] `CHANGELOG.md` has entries for Phases 1–5.
- [ ] CI checks for doc sync.

### Workstream D (Cleanup)
- [ ] No empty JSDoc stubs in `lib/`.
- [ ] `detectLibrariesFromDir` is config-driven.
- [ ] `stubPR` renamed.
- [ ] `commandTriggers` removed.
- [ ] ESLint config enforces `no-empty-jsdoc`.

### Workstream E (Performance)
- [ ] `gatherContext` summarizes long threads.
- [ ] `fix.maxTokensPerIteration` enforced.
- [ ] `verifyResolution` calls parallelized (Phase 1 dependency).
- [ ] Token usage surfaced in Step Summary (Action path).

### Workstream F (Polish)
- [ ] `/help`, `/overrides` commands exist.
- [ ] `/reconcile-comments --all` works (admin-only).
- [ ] `/audit --dry-run` works.
- [ ] `/discover --since=<date>` works.

---

## 6. Rollout Steps

Phase 6 is the most parallelizable — the six workstreams are largely independent.

1. **PR-6.1 (Workstream A):** E2E test suite. Can start as soon as Phase 1 lands (to test verify-resolution). Add tests incrementally as each phase ships.
2. **PR-6.2 (Workstream B):** `/why` command. Depends on Phase 1's `comment_actions` table.
3. **PR-6.3–6.5 (Workstream C):** Documentation. Can start any time. Spec files should be written **before** each phase ships (as design docs), then updated after.
4. **PR-6.6 (Workstream D):** Code cleanup. Independent. Can land any time.
5. **PR-6.7–6.9 (Workstream E):** Performance. Independent. Land after Phases 1–5 so the optimizations apply to the final code shape.
6. **PR-6.10–6.13 (Workstream F):** Polish commands. Each is small and independent.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| E2E tests are flaky due to mock setup complexity | High | Medium | Invest in good helpers upfront. Use fixture files for complex payloads. Run e2e tests separately from unit tests in CI. |
| `/why` exposes sensitive info (e.g. who bypassed a gate) | Low | Low | The audit trail is only accessible to repo collaborators. No sensitive info beyond what's already in the issue thread. |
| Documentation drifts from code | High | Low | CI check that regenerates `docs/commands.md` from `parseCommand`. Spec files are versioned with the code. |
| Removing `commandTriggers` breaks existing configs | Low | Low | Add a deprecation warning for one release, then remove. The new `commandPrefix` covers the same use case. |
| `gatherContext` summarization loses important context | Medium | Medium | Summarization preserves bot's own comments verbatim. Only maintainer comments older than N comments get summarized. The summarization prompt explicitly preserves decisions and answers. |
| Token budget enforcement aborts legitimate fixes | Low | Medium | Set the default high (100000 tokens). Make it configurable. Log clearly when aborted. |

---

## 8. Open Questions

1. **Should the e2e tests run against a real GitHub repo (staging) or pure mocks?** Recommendation: pure mocks for CI, with a separate staging-repo smoke test that runs nightly.

2. **Should `/why` be available to all collaborators or only admins?** Recommendation: all collaborators. The audit trail is not sensitive.

3. **Should `docs/commands.md` be in the repo or generated in CI?** Recommendation: in the repo, generated by a pre-merge CI check. Easier for contributors to read.

4. **Should the summarization prompt be a separate LLM call, or can it be done in the main prompt?** Recommendation: separate. The main prompt is already large; a dedicated summarization call is cheaper and more reliable.

5. **Should `/help` post in the issue/PR thread, or DM the user?** Recommendation: post in the thread. DMs require additional scopes and are less discoverable.

6. **Should the polish commands (`/help`, `/overrides`) be available in both App and Action?** Recommendation: App only. The Action runs in CI and doesn't have a conversational interface.

---

## 9. Post-Phase-6 Vision

After Phase 6 ships, the project should be in a stable, well-tested, well-documented state. Future work (not in scope for this plan) could include:

- **Multi-repo pattern sharing:** Patterns learned in one repo could be shared (opt-in) with other repos in the same org.
- **PR review prediction:** Use the LearningStore to predict which PRs are likely to have critical issues before the LLM even runs, and prioritize them.
- **Custom audit categories:** Let maintainers define their own audit category prompts in `.audit-prompts/` (the loader already supports this, but there's no UI to help them write good prompts).
- **IDE integration:** A VS Code extension that surfaces the bot's findings inline as the developer types, before they even push.
- **Cost dashboard:** A web UI (or a GitHub Actions workflow that posts a weekly summary) showing token usage, fix success rate, and question answer rate per repo.

These are intentionally out of scope. Phase 6 closes out the immediate improvement plan.

---

End of Phase 6. This concludes the six-phase improvement plan. Refer back to `IMPROVEMENT-PLAN.md` for the master overview.
