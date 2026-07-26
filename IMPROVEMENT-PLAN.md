# OpenCode AI Reviewer — Improvement Plan

> **Created:** 2026-07-26  
> **Scope:** All five phases cover bugs, UX improvements, new workflows, and code quality improvements discovered through a full codebase audit.

---

## Overview

After a deep audit of the codebase (all source files in `lib/`, `action/`, `app/`, workflows, and configuration), five problem areas were identified. This document is the master index. Each phase has its own detailed plan file linked below.

### Problem Areas Identified

| # | Area | Severity | Phase |
|---|------|----------|-------|
| 1 | PR review workflow does not pass open conversation threads or existing open issue comments as context to the reviewer | High | Phase 1 |
| 2 | Review comments are only marked `OUTDATED` (minimized) — never actually verified/resolved properly | High | Phase 1 |
| 3 | Review issues raised by the bot do not include actionable "how to fix" suggestions | Medium | Phase 2 |
| 4 | Issues are not automatically analyzed on open; `/analyze` is only manual | Medium | Phase 3 |
| 5 | `/fix` on an issue starts immediately without waiting for user answers to blocking questions | High | Phase 3 |
| 6 | When `/fix` creates a PR, the body is pasted from the issue description instead of a proper fix summary | High | Phase 4 |
| 7 | Several smaller UX, reliability, and performance improvements | Low–Medium | Phase 5 |

---

## Phases

### [Phase 1 — PR Review: Conversation Context & Proper Issue Resolution](./docs/improvement/phase-1-review-context-resolution.md)

**Goal:** Make the review workflow aware of all open conversations and existing unresolved issues on each PR. When a subsequent review determines an issue is genuinely fixed, resolve (collapse) its comment thread — not just mark it outdated.

Key changes:
- Pass open review thread bodies as context in the review prompt
- Distinguish between "truly fixed" vs "still open but code changed" before resolving threads
- Use `resolveReviewThread` GraphQL mutation (already in `github.ts`) instead of only `minimizeReviewComment`
- Close linked issues on PR merge when all review items are cleared

---

### [Phase 2 — Review Suggestions: Actionable Fix Guidance](./docs/improvement/phase-2-review-suggestions.md)

**Goal:** Every non-trivial issue the bot raises should include a concrete suggestion of how to fix it. Easy fixes should include a `suggestion` diff block for one-click apply.

Key changes:
- Update review prompt to require `suggestion` field for all issues
- For simple/mechanical issues, generate a proper code suggestion diff (multi-line)
- Severity-gate suggestions: always required for CRITICAL, recommended for IMPORTANT, optional for MINOR
- Add suggestion quality check in the meta-verification pass

---

### [Phase 3 — Issue Analysis & Question Workflow](./docs/improvement/phase-3-issue-analyze-questions.md)

**Goal:** When an issue is opened, automatically run `/analyze` and post an implementation plan. If the analysis has blocking unknowns, ask targeted questions. When `/fix` is triggered and there are unanswered blocking questions, wait for the user to reply before starting.

Key changes:
- Add `issues.opened` webhook handler to auto-trigger `handleAnalyzeCommand`
- Add "questions" section to the analysis plan output format
- Add state tracking: `analysis:ready` vs `analysis:needs-input` labels
- `/fix` command checks for unanswered blocking questions before proceeding
- User answers are gathered from issue comments, bundled with the fix context

---

### [Phase 4 — Fix Workflow & PR Body Quality](./docs/improvement/phase-4-fix-pr-body.md)

**Goal:** When the fix agent creates a PR from an issue, the PR body should be a proper fix summary — what was changed, why, and how it relates to the issue. Not a copy-paste of the issue description.

Key changes:
- Fix `createAutofixPR` in `commands.ts` and `runFixIssue` in `action/src/fix.ts` — both use `${issue.body}` verbatim
- The fix agent already writes `.fix-summary.md` — use it as the PR body
- Add a PR body template: summary of changes, files changed, test plan, linked issue
- Add `buildPRBody()` utility used consistently in both action and app paths

---

### [Phase 5 — Additional Improvements & Recommendations](./docs/improvement/phase-5-additional-improvements.md)

**Goal:** Catch-all for the remaining improvements discovered during audit: reliability, DX, test coverage gaps, workflow polish, and future feature ideas.

Key changes:
- Fix `issues.opened` event not subscribed in the Probot app (`index.ts` has no handler)
- Deduplicate the identical `buildReviewBody` / `buildFixBody` functions between `action/src/fix.ts` and `app/src/handlers/autofix.ts`
- Add `analyze` subscriber for auto-analysis on issue open
- Improve the `/fix` waiting flow in the self-review workflow (currently `fix-issue` job has no gate for pending questions)
- Better error messaging when fix agent is stuck (surface `stuckReason` in PR comment)
- Probot app: subscribe to `issues.opened` for auto-analyze
- Add a `resolvedBy` field to the issue close comment linking back to the fix PR
- Action mode `analyze` is missing from `action/src/index.ts` dispatch — only exists in Probot app

---

## Implementation Order

The phases are ordered by impact and dependency:

```
Phase 3 (Issue Analyze + Questions)
  ↳ must come before Phase 4 (Fix Workflow), because the question-gate 
    is a prerequisite for the improved fix flow

Phase 1 (Review Context + Resolution)
  ↳ independent, can be done in parallel with Phase 3

Phase 2 (Review Suggestions)
  ↳ depends on Phase 1 (prompt changes build on the same review prompt)

Phase 4 (Fix PR Body)
  ↳ depends on Phase 3 (uses fix summary from analyze/fix pipeline)

Phase 5 (Additional Improvements)
  ↳ largely independent, can be done in parallel with any phase
```

Recommended order for a single developer:

1. Phase 1 (high severity, self-contained)
2. Phase 3 (high severity, new workflow)
3. Phase 4 (quick win once Phase 3 is done)
4. Phase 2 (medium effort, improves review quality)
5. Phase 5 (ongoing, pick up issues as time allows)

---

## Files Affected (Summary)

| File | Phases |
|------|--------|
| `lib/src/utils/github.ts` | 1, 2 |
| `lib/src/engine.ts` | 2, 3 |
| `lib/src/prompts/builder.ts` | 2, 3 |
| `lib/src/types/index.ts` | 3 |
| `app/src/index.ts` | 3, 5 |
| `app/src/handlers/commands.ts` | 3, 4 |
| `app/src/handlers/autofix.ts` | 1, 4, 5 |
| `action/src/fix.ts` | 3, 4 |
| `action/src/index.ts` | 3, 5 |
| `.github/workflows/self-review.yml` | 3, 5 |
