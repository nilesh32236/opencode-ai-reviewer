# Autonomous campaign state

> **This file is navigation, not authority.**
> It is a snapshot that is wrong the moment anything merges. Before acting on any
> line below, re-verify it against live GitHub (`gh pr list`, `gh pr view`,
> `gh issue list`) and the working tree. Where this file and live state disagree,
> **live state wins, every time.** Nothing in `.github/`, `scripts/`, or
> `package.json` reads this file, so it cannot influence a merge decision — and
> if it ever appears to, that is a bug.
>
> Canonical merge policy lives in `AUTONOMOUS_PLAN.md` and in
> `.github/scripts/autofix-merge-approval.sh`. This file deliberately does not
> restate it, because a second unsynchronized copy of a security control is a
> liability, not a convenience.

**Snapshot taken:** 2026-09-28, against `main` = `332f4775`.

---

## 1. Merge authorization — the only thing that permits a merge

`autofix:merge-approved`, applied by a non-bot human, bound to the current head
SHA, postdating the head commit. `autofix:ready` is **advisory only** and never
authorizes a merge. Full contract:
`.github/scripts/autofix-merge-approval.sh`.

**Verified state at snapshot: no open PR carries `autofix:merge-approved`.**
Therefore **nothing is mergeable right now**, regardless of technical
readiness. Eight open PRs additionally carry `autofix:needs-manual-review`,
which that script treats as a *forbidden* label.

### Known control gap

`main` has **no branch protection and no rulesets** (`branches/main/protection`
→ 404, `rulesets` → `[]`). The gate is only invoked from CI merge sites
(`ai-review.yml`, `hourly-orchestrator.yml`), so it protects the automation, not
the branch. Any write-scoped token can merge directly. Tracked in **#920**.

---

## 2. Open PR dispositions

Re-derive every row before acting. These are evidence-based as of the snapshot.

| PR | Disposition | Basis |
|---|---|---|
| **#929** | `MANUAL_APPROVAL_REQUIRED` | Aligns the MCP pin with the lockfile and makes `drift` fail CI (see #918). Mutation-verified. Ready, unauthorized. |
| **#926** | `MANUAL_APPROVAL_REQUIRED` | Fixes the health-watchdog duplicate lookup. Ready, unauthorized. |
| **#923** | `MANUAL_APPROVAL_REQUIRED` | Fixes the `question-answered` fail-open. Mutation-verified. Ready, unauthorized. |
| **#911** | `MANUAL_APPROVAL_REQUIRED` | Rebased onto `main` (was CONFLICTING), conflict resolved by keeping both test blocks. Mutation-verified. Closes residual F5 of #840. |
| **#893** | `NEEDS_FIX` | **Headline claim refuted.** Its `find_open_issue` still routes `--arg` to `gh` (a JQ flag); the query always fails, so dedup never worked. See #926. Also: saturation guard is unreachable and would kill the watchdog under `set -e`. |
| **#880** | `NEEDS_FIX + NEEDS_TESTS` | Real hardening, 0% superseded, but the audit-category allowlist makes a rejected category a **green no-op** (`core.warning` + `return`, no `setFailed`) — filed as **#924**. |
| **#857** | `NEEDS_FIX` | `PROVIDER_ENV_VARS` keys (`openai`, `ollama`, …) do not match `LLMProviderType` (`openai-compatible`, `bedrock`, …); verified by driving `runOpenCode` — the most common provider gets a false "not needed" warning and no narrowing. Headline "caught before execution" is **false by default** (both resolvers are `=== 'true'`). Undisclosed CI permission inversion. |
| **#853** | `NEEDS_TESTS` | Trust chain verified sound; attestation is genuinely verified (re-hashed, `timingSafeEqual`), and Docker/Probot is **not** broken. But deleting `await assertPathBinaryAttested(existingPath)` from `setupOpenCode`'s PATH branch **survives the whole suite** — a pure coverage hole. Default flip breaks the CLI download path more widely than the body discloses. |
| **#851** | `NEEDS_FIX` | Superseded by this file. Its `## Current baseline` was already factually wrong on 4+ claims and it re-declared merge policy as standing authority without a live-state-precedence clause. |
| **#847** | `NEEDS_FIX` | Truncation/staging/bundle-sync verified good. But `withRetry` is wrapped around **non-idempotent writes** (issue creation, review posting) → duplicate issues/reviews; a skipped post-review refresh lets a **stale SHA reach the CI gate**; comment scan 1000→300 causes hard aborts. |
| **#845** | `NEEDS_TESTS` | Genuine hardening, but the body is wrong — `sanitizeErrorMessage` already exists on `main`. Truncates **before** redacting, so a token straddling the cap leaks a credential prefix (empirically proven) — filed as **#925**. Convention guard matches exactly one syntactic shape. |
| **#772** | `NEEDS_FIX` | 0% superseded, good ESM/env work. But scope exceeds #771 ~5×, and `stripUnsafeSubprocessEnv` silently strips `PATH`/`HOME`/`NODE_OPTIONS`/`LD_*`/`GIT_*` from **every** MCP server — the repo's own test had to be edited away from `{ PATH: … }`, which is the evidence a supported config broke. |
| ~~#774~~ | **CLOSED — SUPERSEDED** | 19 commits behind. 4 lines of net-new logic; resolving its conflict by taking the branch side would **delete** `app/src/utils/privilege.ts` (−235), the #917 GH_PAT guard (−292), and cache tests (−197). The 4-line micro-opt is behaviour-preserving but unmeasurable. |

| ~~#928~~ | **CLOSED — DUPLICATE, WEAKER** | Autofix PR for the same two defects as #911 + #923. Its `question-answered` guard (`const login = user?.login; if (!login || login !== issueAuthor)`) blocks a non-string login only when the *other* side is a string; when both sides carry the same non-string it accepts the payload. #923's suite fails 2 of 25 against it. |

### Cross-PR hazards

- **#853 and #857 both heavily edit `lib/src/opencode.ts` and both regenerate `action/lib/*.js`.** A rebase is required for whichever lands second. A review claimed they "contradict" on `resolveRequireChecksum` — **refuted**: #857's diff does not touch that function.
- **#772 and #880 conflict in five files**, including `lib/src/mcp/client.ts`, where the conflict hunk sits adjacent to an env-spread. Resolving it by taking "ours" silently undoes #880's confinement. Resolve by hand, never by side.
- No test in the repo diffs a fresh `pnpm build` against the committed bundle, so a stale-but-symbol-present bundle passes CI. **Check bundle freshness manually on any of the above.**

---

## 3. Security residuals

| Ref | State |
|---|---|
| #840 F1 wrong identity | **FIXED** — mutation now kills 10 tests (was 0/231) |
| #840 F2 subscriber coverage | **FIXED** — 14 subscribers gated. Note `dismiss.ts` calls `verifyCollaboratorPermission` directly, so grepping for the gate name under-reports it |
| #840 F3 test could not detect F1's class | **FIXED** — mutation kills 3 tests. `makeCommentEvent` is *still* paired; #850's test builds its payload directly instead |
| #840 F4 API-error fail-open untested | **FIXED** — mutation kills 2 tests |
| #840 F5 unbounded privilege lifetime | **OPEN** — mutation `return at !== undefined` **survives `main`**. Fixed in #911, which is unauthorized. |
| #920 merge gate unenforced | **OPEN** — needs a ruleset on `main` |
| #922 question-answered fail-open | **FIXED** in #923, unauthorized |
| #924 audit category green no-op | **OPEN** |
| #925 truncate-before-redact leak | **OPEN** |
| #918 MCP pin drift (`3.2.5` vs lock `3.2.3`) | **OPEN** — `check-mcp-pins.sh` is warn-only by design, so this is permanently invisible. Both versions exist on npm, so the fix is to align the lockfile to the deliberately-chosen pin. |

---

## 4. CI

- The health watchdog's duplicate detector has **never** worked (see #926). The
  29 open `[health]` issues are largely its output. Duplicates are grouped by
  *branch + failing job*, not by fingerprint alone — the fingerprint changes per
  run for the same underlying defect.
- `.github/scripts/tests/test-autofix-merge-approval.sh` and
  `test-sec001-boundary.sh` are the only script-level suites. Both are largely
  `grep -F` assertions, which is why a behavioural defect could sit on `main`
  unnoticed. #926 adds a behavioural suite as a third.
- Possible flaky tests on `main` were reported once (7 files / 28 tests failed,
  immediately green on re-run) and could not be reproduced. **Unattributed.**

---

## 5. Working method that produced results

1. **Reproduce the claim before fixing it.** The `question-answered` fail-open
   and the `gh --arg` bug were both confirmed with a failing test / live
   command *first*.
2. **Assert the mutation was applied and re-read from disk** before trusting a
   mutation result. One "surviving mutation" in this round was actually a
   mutation script that silently failed to apply — it looked like a coverage
   hole and was not.
3. **Do not trust a subagent's central claim.** Two of the three reviewers'
   headline claims were checked and one was refuted outright. Verify, then act.
4. **Prefer behavioural tests over `grep -F`.** A literal-string assertion
   passes on the broken code, because the string is present in both.
5. **Assert absence of the mutation**, not just a return value, or a test can
   pass by returning early for an unrelated reason.
6. **A gap in your own tests can hide a weaker duplicate.** Autofix PR #928
   shipped a variant of the #922 fix that looked equivalent and was not. It was
   only found because the existing cases all compared a non-string login against
   a *string*. Add the case that actually separates the two implementations,
   even when the current fix already passes it.
7. **Check a suspicious shape with the shape you meant.** A probe written as
   `user = 42` tested the wrong thing; the real case was `user = { login: 42 }`.
   One of them passes and the other fails, so the sloppy version would have
   produced a confidently wrong conclusion.

---

## 5a. Correction: the committed-bundle-freshness claim was wrong

An earlier draft of this file, and a subagent's review, both recorded that
"no test in the repo diffs a fresh build against the committed bundle, so a
stale-but-symbol-present bundle would pass CI."

**That is false, and it was never checked.** `.github/workflows/ci.yml` has had
a `Verify committed action bundles are fresh` step that runs
`git diff --exit-code -- action/lib/` after the build and fails the job on any
difference.

Both halves verified on `main` (`332f4775`) rather than assumed:

- **Does a fresh build change the committed bundle?** No — `pnpm --filter
  @opencode-pr-agent/action build` produced no diff, so the gate passes.
- **Does the gate actually catch staleness?** Appending a marker line to
  `action/lib/index.js` made it fail correctly.

The general lesson is the one already recorded as item 2, in a new place: an
unverified claim sat in a state file long enough to be copied into a review.
The check cost one build. It should have been run before the claim was written
down rather than after.

---

## 6. Remaining work, in priority order

1. **#920** — add a ruleset on `main`. Until then the merge control is advisory.
2. **#911** — highest-value security fix outstanding (closes F5). Needs
   `autofix:merge-approved`; a fresh review is required after its rebase.
3. **#926 / #893** — land the real dedup fix, then re-evaluate #893.
4. **#923** — ready, unauthorized.
5. **#918** — align the MCP pin with the lockfile; consider making `drift` a
   CI failure while leaving `npx-only` a notice.
6. **#924 / #925** — audit fail-open and the credential-prefix leak.
7. **#857's `PROVIDER_ENV_VARS`** — correct the key set to `LLMProviderType`.
8. **#853** — add the missing `setupOpenCode` PATH-attestation test (the one
   mutation that currently survives the whole suite).
9. **#847** — de-wrap `withRetry` from non-idempotent writes; close the
   stale-SHA CI-gate window.
10. **#772 / #880** — resolve the shared-file conflicts by hand, never by side.
11. **#851** — close as superseded by this file.
12. ~~Falsifiable claim~~ — **RESOLVED, claim was wrong.** See the correction below.
