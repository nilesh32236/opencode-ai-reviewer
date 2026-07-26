# OpenCode AI Reviewer — Improvement Plan (Master)

> **Scope:** Fixes and improvements for the `opencode-ai-reviewer` project after a full codebase audit.
> **Author:** Super Z (codebase review pass)
> **Date:** 2026-07-26
> **Status:** Draft — ready for maintainer review

This is the **master plan**. Each phase has its own dedicated markdown file under `improvement-plans/phase-N-*.md` with file-level changes, code snippets, acceptance criteria, and rollout steps. Read this file first, then dive into the phase that interests you.

---

## 1. Why this plan exists

The audit (see "Audit Findings" below) found that several core workflows ship with subtle but high-impact bugs that match the user's complaints exactly:

1. The **review→resolve→collapse** loop collapses old review comments as `OUTDATED` based only on a `file:line` positional match — it never verifies the code actually fixed the issue, never re-opens comments that come back, and never uses the `resolveReviewThread()` mutation that the codebase already implements but never calls.
2. **`/fix` does not gate on clarifying questions.** The analyze prompt asks questions inside a markdown comment, but nothing parses them, nothing tracks their answer state, and `/fix` proceeds immediately — picking an implementation strategy on the LLM's own.
3. The **autofix PR body literally copy-pastes the issue body.** The fix summary that the LLM writes (`fixResult.summary`) is generated and then discarded.
4. There is **no auto-analyze on issue open**, even though the `AnalyzeResult` type and `runAnalyze` engine method both exist.
5. Slash commands use **substring matching** (`body.includes('/fix')`) — a comment like "what's the fix here?" triggers the entire autofix flow.
6. The **App and Action code paths diverge** — the Action minimizes stale comments; the App never does. The Action passes `previousBotComments` to the review prompt; the App does not, so every `pr.synchronize` re-reports everything.

This plan addresses all of the above plus a set of secondary improvements surfaced during the audit.

---

## 2. Audit Findings (at a glance)

| # | Finding | Severity | Files (key locations) |
|---|---|---|---|
| F-1 | PR body for autofix = copy-paste of issue body; `fixResult.summary` discarded | High | `app/src/handlers/commands.ts:375`; `action/src/fix.ts:254-256` |
| F-2 | No question gating on `/fix` | High | `app/src/handlers/commands.ts:313-343`; `action/src/fix.ts:184-227` |
| F-3 | Analysis plan stored only as markdown comment; structured `AnalyzeResult` never populated | High | `lib/src/engine.ts:585-623`; `lib/src/types/index.ts:534-553` |
| F-4 | No auto-analyze on issue open (no subscriber for `issues.opened`; routing exists) | High | `lib/src/event-bus/router.ts:5-29`; `app/src/index.ts` |
| F-5 | Resolved-vs-outdated distinction is purely positional and unverified | High | `action/src/fix.ts:549-573` |
| F-6 | `resolveReviewThread()` called in autofix loop via `resolveFixedComments` but not during standalone reviews | Medium | `lib/src/utils/github.ts:1343-1354`; `lib/src/utils/autofix-body.ts:218-265` |
| F-7 | No re-opening of incorrectly-minimized comments | Medium | (missing — no `unminimize` call anywhere) |
| F-8 | App review path does not pass `previousBotComments` → duplicates on every push | High | `app/src/handlers/pr-review.ts:52-62` |
| F-9 | App autofix loop has no minimization / resolution at all | Medium | `app/src/handlers/autofix.ts` (entire file) |
| F-10 | Slash commands use substring matching → false triggers | Medium | `app/src/index.ts:49,125,155,175,236` |
| F-11 | App `/fix` does not distinguish PR vs issue | Medium | `app/src/handlers/commands.ts:77-117` |
| F-12 | `previouslyReported` flag is set by LLM but never acted on | Low | `lib/src/types/index.ts:60`; `action/src/fix.ts` (no reader) |
| F-13 | Two `buildReviewBody` implementations with subtly different formatting | Low | `lib/src/jsonl-parser.ts:285-321`; `lib/src/utils/github.ts:1398-1452` |
| F-14 | Top-level `action.yml` and `action/action.yml` have drifted (missing inputs) | Low | `action.yml`; `action/action.yml` |
| F-15 | `max_lines_per_file` default mismatch (200 vs 500) | Low | `lib/src/types/index.ts:744`; `action/src/inputs.ts:112` |
| F-16 | No `/discover` slash command wired up (specified but not implemented) | Low | `app/src/index.ts` (no subscriber) |
| F-17 | Empty JSDoc stubs throughout `lib/` | Low | many files |
| F-18 | Hard-coded PHP/WordPress heuristics in `detectLibrariesFromDir` | Low | `lib/src/engine.ts:1217-1265` |

A detailed walkthrough with line numbers for each finding is in the individual phase files.

---

## 3. Phase Index

| Phase | Title | Severity | Effort | File |
|---|---|---|---|---|
| 1 | Review workflow correctness — verify, then resolve, then collapse | High | M | `phase-1-review-workflow.md` |
| 2 | Issue analysis — auto on open, manual `/analyze`, structured Q&A tracking | High | L | `phase-2-issue-analysis.md` |
| 3 | Autofix — question gating + real PR body from fix summary | High | M | `phase-3-autofix-gating.md` |
| 4 | Command reliability — regex matching, PR-vs-issue distinction, labels | Medium | S | `phase-4-command-reliability.md` |
| 5 | App ↔ Action parity — converge the two code paths | Medium | L | `phase-5-app-action-parity.md` |
| 6 | Additional improvements — tests, observability, docs, cleanup | Medium | M | `phase-6-additional-improvements.md` |

**Effort legend:** S = small (≤1 day), M = medium (1–3 days), L = large (3+ days).

**Recommended execution order:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6.

Phases 1–3 form the critical path that directly addresses the user's top complaints. Phase 4 and 5 are correctness/consistency work that prevents recurrence. Phase 6 is polish.

---

## 4. Architectural Principles for the Fixes

The following principles apply across all phases. They are non-negotiable:

1. **Single source of truth for any logic that runs in both App and Action.** Today, the autofix loop is duplicated between `app/src/handlers/autofix.ts` and `action/src/fix.ts:runAutofixLoop` with subtle divergences. Phase 5 extracts a single shared function in `lib/` that both paths call. New logic must be added to the shared function only.

2. **Structured state over markdown scraping.** The current design embeds machine-readable information (analysis plan, outstanding questions, prior findings) inside markdown comments and re-parses it with substring matching (`issueContext.includes('<!-- issue-analysis-plan -->')`). Every new feature that needs state must use a real data store: either the existing LearningStore SQLite DB (`lib/src/learning/`) or a new structured JSON sidecar committed to the workspace. Never parse markdown for state.

3. **LLM judgment gated by deterministic checks.** Whenever the LLM's output drives a destructive side effect (minimizing a comment, opening a PR, closing a thread), the decision must be wrapped in a deterministic verifier. The LLM may *suggest*, but a typed code path must *confirm*.

4. **Human-in-the-loop is opt-out, not opt-in.** When the system has an open question for the maintainer, the default behavior is to **wait**, not to guess. The maintainer can opt out by config (`fix.autoProceedWithoutAnswers: true`) but the default is conservative.

5. **No silent data loss.** If the LLM generates a fix summary, that summary is surfaced (in the PR body, in the iteration comment, in the audit trail). If a comment is minimized, the reason is logged. If a question is asked, the answer is recorded. Every action has a trail.

6. **Tests before refactor.** Each phase starts by adding regression tests that pin the current (buggy) behavior, then refactors. This makes it impossible to silently regress when consolidating App and Action paths.

---

## 5. Phase Summaries (one-paragraph preview each)

### Phase 1 — Review workflow correctness
Replaces the current "positional match → minimize as OUTDATED" loop with a three-step verifier: (a) detect that a previously-reported comment is no longer in the new findings, (b) run a small LLM `verify-resolution` sub-pass that reads the current file content and classifies the comment as `FIXED`, `STILL_PRESENT`, `MOVED`, or `OBSOLETE_CONTEXT`, (c) act on each classification — only `FIXED` minimizes the comment, `STILL_PRESENT` re-posts with `previouslyReported: true`, `MOVED` updates the comment's line, `OBSOLETE_CONTEXT` calls `resolveReviewThread()` (the mutation that has existed since the project's birth and never been used). Adds `unminimizeReviewComment()` for the case where a `STILL_PRESENT` comment had been incorrectly minimized in a prior iteration. Adds structured logging of every decision to the LearningStore so the maintainer can answer "why was my comment hidden?"

### Phase 2 — Issue analysis
Wires up `issues.opened` → auto-analyze (gated by an opt-in label or config flag so it doesn't fire on every repo). Replaces the markdown-only analysis output with a structured `AnalyzeResult` JSON sidecar (`.opencode/analysis-plan.json`) carrying `priority`, `affectedFiles[]`, `implementationPlan[]`, and crucially `questionsForMaintainer[]` as a typed array. Each question gets a stable `questionId`. Adds a new `issue_questions` table to the LearningStore that tracks `askedAt`, `answeredAt`, `answerText`, `answeredBy`. A new `reply` subscriber watches issue comments and matches them to open questions (by quoted text or by maintainer reply-to marker). The manual `/analyze` command is kept and now also writes the structured sidecar, so manual and automatic analysis share the same code path.

### Phase 3 — Autofix with question gating + real PR body
Inserts a pre-fix gate in both `createAutofixPR` (App) and `runFixIssue` (Action): before calling `engine.runFix`, query the LearningStore for open questions on this issue. If any are open and unanswered, post a single consolidated comment listing them with `⏸️ Waiting for answers` and return without fixing. When the maintainer answers (Phase 2's reply subscriber marks questions as answered), the maintainer re-runs `/fix` and it proceeds. Replaces the PR body construction with a proper template: `## Fixes #N` + `## Summary` (from `fixResult.summary`) + `## Files Changed` (from `fixResult.filesChanged`) + `## Implementation Plan Followed` (from the structured plan) + `## Original Issue` (collapsed `<details>` block with the issue body, not the whole thing as the top-level body). Adds a `/fix --force` escape hatch for maintainers who want to bypass the gate.

### Phase 4 — Command reliability
Replaces every `body.includes('/cmd')` with an anchored, case-insensitive regex `^\s*/cmd\b` that requires the command at line start. Adds a configurable command prefix so `/oc` and `/` can both be supported cleanly. Adds explicit PR-vs-issue disambiguation in the App's `/fix` handler (today it would create a new autofix PR against a PR number). Adds the missing `/discover` subscriber for the pattern detector that was specified but never wired. Adds a `--dry-run` flag to `/fix` that runs the gate and plan steps but stops before pushing commits.

### Phase 5 — App ↔ Action parity
Extracts the duplicated autofix loop into `lib/src/autofix/loop.ts` with a single `runAutofixLoop(opts)` function. Both `app/src/handlers/autofix.ts` and `action/src/fix.ts:runAutofixLoop` become thin wrappers that supply environment-specific bits (workspace path, token, runner type) and delegate. Same extraction for `createAutofixPR` vs `runFixIssue`. Aligns `app/src/handlers/pr-review.ts` to fetch `getBotReviewThreads` and pass `previousBotComments` (today the App doesn't, causing duplicate comments on every push). Resolves the `action.yml` vs `action/action.yml` drift by deleting the top-level one and updating `examples/` workflows to point at `action/action.yml`. Aligns the `max_lines_per_file` default.

### Phase 6 — Additional improvements
Adds regression tests for the analyze→fix round-trip, the verify-resolution sub-pass, and the question-gating gate. Adds structured logging of every minimize/resolve/unminimize decision to the LearningStore with a new `comment_actions` table. Adds a `/why` slash command that, given a comment URL, prints the audit trail for that comment. Cleans up empty JSDoc stubs. Removes the hard-coded PHP/WordPress heuristics in `detectLibrariesFromDir` and replaces them with a config-driven `libraryDetection.patterns` array. Documents the App-vs-Action architecture and the new verify-resolve-collapse flow in `README.md`. Adds a `CHANGELOG` entry for each phase.

---

## 6. Cross-Cutting Recommendations

These do not fit cleanly into any single phase but should be considered throughout:

1. **Adopt a typed webhook payload layer.** Today every subscriber in `app/src/index.ts` re-casts `event.payload as Record<string, unknown>` and walks nested fields with `?.` chains. The Probot library ships typed payloads — adopting them would eliminate an entire class of runtime crashes. Effort: S. Worth doing in Phase 5.

2. **Add a `--dry-run` mode to every destructive command.** `/fix --dry-run`, `/audit --dry-run`. Useful for testing prompts without side effects. Effort: S. Land in Phase 4.

3. **Surface `fixResult.summary` everywhere it makes sense.** Today it's only in the iteration comment. It should also be in the PR body (Phase 3), in the LearningStore `findings` table (so meta-review can read it), and in the GitHub Step Summary (for the Action path). Effort: S. Land in Phase 3.

4. **Document the implicit "resolved-by-position" → "resolved-by-verification" migration.** Existing repos will have comments that were minimized under the old rule. Phase 1 should include a one-time reconciliation pass (gated behind a config flag) that re-evaluates all currently-minimized bot comments and un-minimizes any that the new verifier classifies as `STILL_PRESENT`. Effort: M. Land at the end of Phase 1.

5. **Add a config schema version field.** `.opencode-reviewer.yml` should declare `schemaVersion: 1`. Future breaking changes to the config can then trigger a migration prompt instead of silently being misinterpreted. Effort: S. Land in Phase 5.

6. **Consolidate the two `buildReviewBody` implementations.** `lib/src/jsonl-parser.ts:285-321` and `lib/src/utils/github.ts:1398-1452` do the same thing slightly differently. Pick one (the `github.ts` version, since it's used by the App), delete the other, update callers. Effort: S. Land in Phase 5.

7. **Add a per-issue "context window budget" guard.** Today, `gatherContext` fetches the entire issue body + all comments and jams it into the prompt. On long threads (50+ comments), this can blow the context window. Add a summarization pass that compresses older comments into a single "previous discussion summary" line. Effort: M. Worth considering for Phase 6.

8. **Track and surface token cost per fix.** The telemetry spec (`docs/superpowers/specs/2026-07-25-telemetry-learningstore-design.md`) added token tracking to `runOpenCode`. Surface `tokensUsed` per autofix iteration in the iteration comment so maintainers can see how expensive a fix was. Effort: S. Land in Phase 3.

---

## 7. Rollout Strategy

The phases are designed to land in order with minimal cross-dependencies. Recommended rollout:

1. **Phase 1** lands first. It's the highest-severity fix and touches the most user-visible surface (PR comments). Ship behind a config flag `review.verifyResolution: true` (default `false` for one release, then `true`).
2. **Phase 2** lands next. It introduces the structured `issue_questions` table and the `issues.opened` subscriber. No existing behavior breaks; the table is additive.
3. **Phase 3** depends on Phase 2 (it queries the question table). Land it immediately after Phase 2. The new PR body template is the most visible change — call it out in the changelog.
4. **Phase 4** is independent. Can land in parallel with Phases 2–3.
5. **Phase 5** is the largest refactor. Land it last so the earlier phases' new logic is added once to the consolidated code path instead of twice.
6. **Phase 6** is continuous — tests, docs, cleanup. Land incrementally as the other phases ship.

Each phase file includes a "Rollout Steps" section with the exact sequence of commits and the acceptance tests that must pass before merge.

---

## 8. Open Questions for the Maintainer

Before starting Phase 1, please confirm:

1. **Default for `review.verifyResolution`:** Should the new verify-then-collapse behavior be on by default, or opt-in for one release cycle? Recommendation: opt-in for one cycle, then on by default.

2. **Reconciliation pass for previously-minimized comments:** Should Phase 1 include the one-time un-minimize pass for comments minimized under the old rule? This could un-hide a lot of comments at once. Recommendation: ship as an opt-in `/reconcile-comments` slash command, not automatic.

3. **Auto-analyze on `issues.opened`:** Should this fire on every issue, or only when an opt-in label (e.g. `needs-analysis`) is applied? Recommendation: opt-in label by default, with a `analyze.autoOnOpen: true` config override for repos that want it on every issue.

4. **Question gating escape hatch:** Should `/fix --force` be available to all maintainers, or restricted to repo admins? Recommendation: available to all maintainers; the audit trail records who bypassed.

5. **PR body template:** Should the issue body be included at all (in a collapsed `<details>` block), or omitted entirely? Recommendation: include in a collapsed block for context, but never as the primary content.

6. **Phase 5 timing:** Are you willing to accept a single-PR consolidation of the App and Action autofix loops, or would you prefer it split across multiple PRs? Recommendation: single PR, but land after Phases 1–4 so the consolidated code includes the new logic on day one.

---

## 9. File Map (what gets touched, by phase)

| Phase | New files | Modified files | Deleted files |
|---|---|---|---|
| 1 | `lib/src/prompts/verify-resolution.ts`; `lib/src/learning/schema.ts` (new table) | `action/src/fix.ts`; `lib/src/utils/github.ts`; `lib/src/types/index.ts` | — |
| 2 | `lib/src/learning/issue-questions.ts`; `app/src/handlers/issue-opened.ts` | `lib/src/engine.ts`; `lib/src/prompts/builder.ts`; `lib/src/event-bus/router.ts`; `app/src/index.ts`; `lib/src/types/index.ts` | — |
| 3 | `lib/src/prompts/fix-pr-body.ts` (template helper) | `app/src/handlers/commands.ts`; `action/src/fix.ts`; `lib/src/engine.ts` | — |
| 4 | `lib/src/utils/command-match.ts` | `app/src/index.ts`; `app/src/handlers/commands.ts`; `lib/src/types/index.ts` (config) | — |
| 5 | `lib/src/autofix/loop.ts`; `lib/src/autofix/issue-fix.ts` | `app/src/handlers/autofix.ts`; `app/src/handlers/commands.ts`; `action/src/fix.ts`; `app/src/handlers/pr-review.ts` | `action.yml` (top-level duplicate); `lib/src/jsonl-parser.ts` (deletes `buildReviewBody`) |
| 6 | `lib/tests/autofix-loop.test.ts`; `lib/tests/verify-resolution.test.ts`; `lib/tests/issue-questions.test.ts`; `docs/architecture.md` | many (JSDoc cleanup, README, CHANGELOG) | — |

---

## 10. How to Read the Phase Files

Each phase file follows this structure:

1. **Goal** — one-paragraph summary of what changes
2. **Background** — the current behavior, with file:line citations, that motivates the change
3. **Design** — the proposed new behavior, with diagrams or code sketches where helpful
4. **File-by-file changes** — every file touched, with the specific edit described
5. **New types / schemas** — additions to `lib/src/types/`
6. **New config keys** — additions to `AgentConfig` / `.opencode-reviewer.yml`
7. **Tests** — the regression tests that pin the new behavior
8. **Acceptance criteria** — bullet list of "done when" statements
9. **Rollout steps** — ordered list of commits / PRs
10. **Risks & mitigations** — what could go wrong and how we handle it
11. **Open questions** — anything that still needs a maintainer decision

Read Phase 1 first; it is the most invasive and sets patterns that Phases 2 and 3 reuse.

---

## 11. TL;DR — One-Line Summary of Each Phase

- **Phase 1:** Stop hiding review comments based on `file:line` positional matching. Add a real LLM verifier that reads the code and classifies each prior comment as FIXED / STILL_PRESENT / MOVED / OBSOLETE_CONTEXT, and act on each classification — including calling the never-used `resolveReviewThread()` mutation.
- **Phase 2:** Auto-analyze issues on open (gated by label/config), store the plan as structured JSON with typed `questionsForMaintainer[]`, track each question's answer state in the LearningStore, and wire the manual `/analyze` command into the same code path.
- **Phase 3:** Before `/fix` runs, check the LearningStore for open questions on the issue; if any are open, post a single "waiting for answers" comment and stop. When the PR is opened, use `fixResult.summary` + `filesChanged` as the PR body — never the raw issue body.
- **Phase 4:** Replace `body.includes('/cmd')` with anchored regexes; disambiguate PR-vs-issue in App `/fix`; add `/discover` and `--dry-run`.
- **Phase 5:** Extract a single `runAutofixLoop` in `lib/` and have both App and Action call it. Align the App's review path to pass `previousBotComments`. Delete the duplicate `action.yml` and the duplicate `buildReviewBody`.
- **Phase 6:** Tests, observability (`/why` command), docs, JSDoc cleanup, config-driven library detection.

---

End of master plan. Continue to `phase-1-review-workflow.md`.
