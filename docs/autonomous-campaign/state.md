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
| **#951** | `MANUAL_APPROVAL_REQUIRED` | The learning-state write used a **fixed** `<path>.tmp` under the workspace checkout, and `writeFileSync` follows symlinks — a branch could plant one and redirect the write. Now `O_CREAT\|O_EXCL` + `0600` on an unguessable name. |
| **#949** | `MANUAL_APPROVAL_REQUIRED` | **The platform declared a three-tier RBAC system and enforced none of it.** `requireRole` was exported and never imported; a `viewer` could enqueue a review for any repository, causing a clone with the platform token plus LLM spend. #948. |
| **#943** | `MANUAL_APPROVAL_REQUIRED` | `opencode-go` was missing from `PROVIDER_API_KEY`, so the #544 least-exposure control silently forwarded **all four** LLM keys into the `--auto` subprocess for a provider the project itself documents. Found via #939. |
| **#941** | `MANUAL_APPROVAL_REQUIRED` | **Every review was silently losing its commit context.** `buildCommitMessages` preferred `pr.headRef` — a branch name a `pull_request` checkout only has as a remote-tracking ref — so `git log base..head` died and the SHA fallback was unreachable. Found via #939. |
| **#940** | `MANUAL_APPROVAL_REQUIRED` | **macOS could not install opencode at all.** `opencode.ts` requested `.tar.gz` on darwin; upstream publishes `.zip` there only, and a missing asset is a hard throw. Fixes the rule, pins the four darwin archives, and corrects two tests that encoded the broken behaviour as intended. |
| **#938** | `MANUAL_APPROVAL_REQUIRED` | Makes the LLM-key/GitHub-credential separation a standing CI invariant (#937). The known violation is declared, so it blocks any *new* one. |
| **#936** | `MANUAL_APPROVAL_REQUIRED` | Bounds a quadratic ReDoS in `isStreamableHandshakeMismatch` on a **remote** MCP server's error body (256 KB → 15.8 s before, 47 ms after). Pre-existing on `main`; CodeQL flags it at high severity. |
| **#934** | `MANUAL_APPROVAL_REQUIRED` | Makes the `issue.labeled` label-actor gate tests discriminating. The gate is a real control and was **completely unpinned** — deleting it left CI green (#812 F3). |
| **#933** | `MANUAL_APPROVAL_REQUIRED` | Loop-level verification coverage, reduced to the two tests that actually discriminate. #733's other two requests survive their own mutations, so they were removed rather than shipped as false coverage. |
| **#932** | `MANUAL_APPROVAL_REQUIRED` | Fixes the audit fail-open sink: an engine that returns no result now fails the job instead of warning and exiting 0 (#924). |
| **#929** | `MANUAL_APPROVAL_REQUIRED` | Aligns the MCP pin with the lockfile and makes `drift` fail CI (see #918). Mutation-verified. Ready, unauthorized. |
| **#926** | `MANUAL_APPROVAL_REQUIRED` | Fixes the health-watchdog duplicate lookup. Ready, unauthorized. |
| **#923** | `MANUAL_APPROVAL_REQUIRED` | Fixes the `question-answered` fail-open. Mutation-verified. Ready, unauthorized. |
| **#911** | `MANUAL_APPROVAL_REQUIRED` | Rebased onto `main` (was CONFLICTING), conflict resolved by keeping both test blocks. Mutation-verified. Closes residual F5 of #840. |
| **#893** | `NEEDS_FIX` | **Headline claim refuted.** Its `find_open_issue` still routes `--arg` to `gh` (a JQ flag); the query always fails, so dedup never worked. See #926. Also: saturation guard is unreachable and would kill the watchdog under `set -e`. |
| **#880** | `NEEDS_FIX + NEEDS_TESTS` | Real hardening, 0% superseded, but the audit-category allowlist makes a rejected category a **green no-op** (`core.warning` + `return`, no `setFailed`) — filed as **#924**. |
| **#857** | `NEEDS_FIX` | `PROVIDER_ENV_VARS` keys (`openai`, `ollama`, …) do not match `LLMProviderType` (`openai-compatible`, `bedrock`, …); verified by driving `runOpenCode` — the most common provider gets a false "not needed" warning and no narrowing. Headline "caught before execution" is **false by default** (both resolvers are `=== 'true'`). Undisclosed CI permission inversion. |
| **#853** | `NEEDS_FIX` + **CI_BLOCKED** | Trust chain verified sound, attestation genuinely verified, Docker/Probot **not** broken. A review claimed deleting `assertPathBinaryAttested` from `setupOpenCode`'s PATH branch survives the suite; **reproduced and refuted** — `opencode.test.ts` kills it (1 failed / 2964 passed), and `opencode-attestation.test.ts` already pins the accept path plus seven named mutations. Residual is design, not coverage: the default flip breaks the CLI download path more widely than the body discloses; no runtime ownership/mode check on the attestation record; the verified verdict is memoised in module-global `opencodePath` so a later swap is not re-checked. **Additionally blocked on CI:** its committed `action/lib/*.js` was built from an earlier source revision, so the shipped `assertPathBinaryAttested` lacks the `try`/`catch` + `markIntegrityError` re-tagging present at `lib/src/opencode.ts:1218-1231`. `pnpm test` is green either way, so only the CI bundle-freshness gate catches it. It is the **only** one of the twelve branches with a stale bundle. Fix: `pnpm build && git add action/lib`. |
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
| #918 MCP pin drift (`3.2.5` vs lock `3.2.3`) | **FIXED in #929** (unauthorized) — lockfile aligned to the deliberate pin, and `drift` now fails CI while `npx-only` stays a notice |
| #930 `PROVIDER_ENV_VARS` keys ≠ `LLMProviderType` | **OPEN** — introduced by #857. `openai-compatible` (the common case) and `bedrock` have no entry and fall through to `generic`, so `OPENAI_API_KEY` is dropped with a warning. Retyping the map to the union makes it a compile error today. |
| #924 audit fail-open sink | **FIXED in #932** (unauthorized) — engine returning no result now calls `setFailed`; the ambiguous empty-but-real case deliberately stays a warning so clean audits do not go red |
| #931 #847 retries non-idempotent creates | **OPEN** — introduced by #847. `createIssue` and `postReview` were bare awaits on `main`; both are now inside `withRetry` with `retryUnknownStatus: true`, so a post-commit 502 produces a duplicate. Contradicts the exactly-once argument 100 lines above the same call. |

### Secret-bearing AI job trust boundary (round 5)

All nine workflows were mapped. The invariant — *model-reachable code must not
hold a write-capable GitHub credential* — is held in two workflows and broken in
one:

| workflow | model job | credential job | verdict |
|---|---|---|---|
| `hourly-orchestrator` | `agent`: LLM keys, `contents: read`, no GitHub token, no `uses: ./` | `publish`: PAT + write, **no LLM keys, no model invocation** | correct |
| `self-improvement` | `agent`/`repair`: LLM keys, `contents: read`, no GitHub token | `publish`: `GH_TOKEN` only; `sec001-trusted-publish.sh` has no model invocation | correct |
| **`upstream-monitor`** | `research`: LLM keys, no GitHub token | **`create-issues`: `GH_TOKEN` AND `OPENCODE_API_KEY` in one env, and `upstream-monitor.sh:356` calls `opencode run --auto` from it** | **violates** |

`--auto` pre-approves tool calls, and the publisher prompt is assembled from
third-party upstream research, so the model executes with tool approval while a
write-capable PAT is in its environment. Filed as **#937**; #938 turns it into a
CI invariant with the known violation declared.

Other jobs verified and *not* violations: `review` and `autofix` check out
`refs/pull/N/merge` and are covered by the same-repository guard from #917;
`fix-issue` and `fast-review` are reachable only from `issues`/`issue_comment`/
`workflow_dispatch`, which check out the default branch rather than a PR ref;
`scheduled-audit` likewise.

---

## 3b. Disposition completeness — every open PR, verified

Audited 2026-09-28 by reading the comment thread on **all 20 open PRs**, not the campaign doc. Two gaps found and closed: **#880** and **#847** had no substantive comment from me at all — my findings existed only as issues (#924, #931), so the PRs themselves carried no disposition. Both now have an evidence-backed disposition as the last word, with the defect re-verified as **still present on the current head**.

| group | count | disposition recorded on the PR itself |
|---|---|---|
| mine (CLEAN, 0 failures) | 13 | `MANUAL_APPROVAL_REQUIRED` in the PR body; all green |
| third-party `NEEDS_FIX` | 5 | #880 #857 #853 #847 #772 — all verified against current head |
| third-party `NEEDS_TESTS` | 1 | #845 — verified patch posted on the PR |
| third-party headline refuted | 1 | #893 — refutation with reproduction |
| closed / superseded | 3 | #774 #851 #928 — recorded here and on each PR |

**Of the six third-party PRs carrying `autofix:needs-manual-review`, five were found to need further work and one (#845) needed tests only.** None is mergeable as it stands, and none is mergeable by me.

---

## 4. CI

### Round-4 triage: no PR was failing a test

Every blocking check was re-diagnosed, and **none of them was a test failure**:

| PR | reported failing | actual cause |
|---|---|---|
| #853 | `test (24)` | **`Verify committed action bundles are fresh`.** `pnpm test` passes (lib 2965, all green). The committed `action/lib/*.js` was built from an earlier source revision, so the shipped `assertPathBinaryAttested` lacks the `try`/`catch` + `markIntegrityError` re-tagging at `lib/src/opencode.ts:1218-1231`. Only branch of twelve with a stale bundle. Fix: `pnpm build && git add action/lib`. |
| #857 | `test (24)` | **`Verify Docstring Coverage`.** 11 missing `@param` declarations, 11 of them on parameters this PR added, all auto-fixable with `pnpm doc:fix`; tests green. |
| #880 | `CodeQL` | 3 × `js/polynomial-redos` at `lib/src/mcp/client.ts:167-169` — **pre-existing**, not in that PR's diff. It surfaced only because #880 changes 16 files and CodeQL widened its analysis. Fixed on `main` by #936. |
| #772 | `Autofix review loop` | The LLM review agent did not complete. A review-quality signal, not a build or code defect. |

**Lesson worth keeping:** two of four "test failures" were not test failures, and a third was a pre-existing defect blamed on the wrong PR. Always reproduce locally and identify the failing *step* before acting — `gh run view --log-failed` is expired here, and a fresh `pnpm test` on the branch head settles it.

- The health watchdog's duplicate detector has **never** worked (see #926).
- **Health backlog reconciled: 30 → 3.** The decisive test was not the branch
  being live but whether the report's run matches the **current head SHA**.
  13 of 16 remaining reports referenced commits the branch had already moved
  past, so they described failures that may or may not still exist — judging
  them either way would mislead. 12 more pointed at branches whose PR was
  merged or closed. The two `main` reports referenced runs from before a
  window in which `main` recorded 14 success / 14 skipped / 10 cancelled /
  **0 failures**, so they no longer reproduce.
  The 3 survivors (#921 → #772, #910 → #853, #899 → #893) all match their
  branch's current head and are cross-linked to the PR that owns them.
- This cleanup is **not durable** until #926 merges: the watchdog will keep
  filing, because the dedup fix is itself awaiting human approval.
- Group by *branch + failing job*, and gate on the head SHA, not on the
  fingerprint — the fingerprint changes per run for the same underlying defect.
- `.github/scripts/tests/test-autofix-merge-approval.sh` and
  `test-sec001-boundary.sh` are the only script-level suites. Both are largely
  `grep -F` assertions, which is why a behavioural defect could sit on `main`
  unnoticed. #926 adds a behavioural suite as a third.
- Possible flaky tests on `main` were reported once (7 files / 28 tests failed,
  immediately green on re-run) and could not be reproduced. **Unattributed.**

---

### Reconciled and closed

| issue | why closed |
|---|---|
| #812 (auth audit, 10 findings) | 9 fixed on `main`, verified individually. The 10th — the `issue.labeled` label-actor gate — was implemented but **unpinned**: deleting it left CI green, because the negative tests were one-sided and the gate's real `fetch` was unmocked. #934 fixes the tests. |
| #856 (SHA-pin actions) | Satisfied: 110 of 110 `uses:` references are SHA-pinned. |
| #788 (checksum fail-closed) | Duplicate of #835, whose residual is `resolveRequireChecksum()` being fail-open for lib/CLI callers. Cross-linked, not closed. |
| 28 health reports | See section 4. |

---

## 4c. Round 7: the health reporter was generating its own false backlog

Three new health reports arrived. **All three were false, and all three shared one signature.**

| issue | run | agent's terminal message | then |
|---|---|---|---|
| #899 | `36389235257` | `Fix agent could not resolve the issues automatically. Needs manual review.` | `pnpm test` exit 1 |
| #921 | `36418517590` | same | same |
| #935 | `36432214835` | `Git operations failed during fix application. Needs manual review.` | same |

The autofix loop runs its verification command on its **own mutated working tree** after it has already failed with a specific reason. The red result becomes the job outcome, and `workflow-health.yml` files it as a repository defect.

Verified it is not a `main` problem, on a pristine checkout of exactly the SHA #935 names:

```
(cd lib && npx vitest run tests/opencode.test.ts)   → 181 passed
pnpm test                                            → lib 2875, exit 0
```

The failures exist only inside the agent's tree. Filed as **#942**; #899, #921 and #935 closed as false, with the evidence.

This is very likely a large part of why the backlog reached 30: most of those reports described the agent's edits, or commits a branch had already moved past.

**#910** (the stale bundle on #853) is the one genuine new report, and it independently confirmed the round-4 diagnosis. Its class `test-fail` is wrong for the same reason — it is a generated-artifact check; suggested `stale-artifact`.

**#939** was my own branch. Its failure was a transient `UnknownError` from the `opencode-go/space-bunny-free` provider — handled correctly by the action. The durable bug it surfaced is the `buildCommitMessages` ref resolution, fixed by **#941**.

Health backlog: **5 → 1** (only #910, which is a real report awaiting the author's rebuild).

---

## 4d. Round 8: `platform/` was unreachable by a `viewer`

The first genuinely unexamined package. `platform/` declares `admin` / `reviewer` / `viewer`, persists it, signs it into the session JWT, validates it on decode, and returns it from `/auth/me` — and **never checks it**:

```
$ grep -rn "requireRole" --include=*.ts .
./platform/dist/auth/middleware.d.ts:29:export declare function requireRole(...)
./platform/src/auth/middleware.ts:56:export function requireRole(...)

$ grep -rn "session\.role" platform/src/
(no output)
```

The only gate on `/api` was `requireAuth`. Behind it, `POST /api/tasks` read `repo` from the body and the worker turned it into a clone and a token-bound adapter (`worker.ts:209`):

```ts
const ws = await workspaces.create(repo, id, `https://github.com/${repo}.git`, headSha);
const gh: PlatformAdapter = new GitHubHelper(githubToken, repo);
```

No repo allowlist exists in `platform/` at all. A logged-in `viewer` could clone any repository with the platform's token, spend LLM budget, and comment on the PR. It was worse than a missing check because `/auth/me` re-reads the role from the database, so the UI *displayed* `viewer` while the API authorized everything.

Filed as **#948**, fixed by **#949**: `requireRole('reviewer')` mounted per-route, `repo` shape-validated, `type` validated at runtime via a type guard rather than an `as`-cast. The repo allowlist is left as remaining work — a new configuration surface, and not a call to make unilaterally.

The existing test harness mounted the router with **no session**, so the new guard broke the pre-existing enqueue test. That is the guard proving it is live, and the harness now mounts a configurable stand-in for `requireAuth`.

### The health backlog has three independent causes

By round 8 it had regenerated to 5. All five were false, from three distinct causes, now all recorded on **#942**:

1. **The loop verifies its own mutated tree** (#899, #921, #935).
2. **Reports about commits the branch moved past** (#945, #946, #947) — three in 50 minutes, all on superseded SHAs. The branch was alive throughout, so liveness is not the test; the **head SHA** is.
3. **Re-filing an unchanged run** (#944 re-filed #939's run with a *different* fingerprint) — the dedup key is not a function of the run, so it misses rather than suppresses.

The one genuine new report, **#910**, independently confirmed the round-4 stale-bundle diagnosis on #853.

Health backlog: **5 → 1**.

---

## 4f. Round 9: two more unexamined paths, both real

**`platform/` CSRF (`#949`, second commit).** CodeQL failed the RBAC PR with `Missing CSRF middleware` at `server.ts:162` — `app.use(cookieParser())`, a line the branch never touched. The condition was pre-existing; changing the sources widened CodeQL's analysis enough to surface it. The session is a cookie and the state-changing routes had no cross-origin check at all; what held the line was the cookie's `sameSite: 'lax'`. That is a *browser* contract, so a future change to `sameSite` would remove the protection silently. Added an origin check with a `Referer` fallback; disabled with a warning when no public base URL is configured, rather than guessing an origin and locking every user out. Three mutations killed, including the classic `includes` lookalike-host bypass.

**`lib/src/learning/json-db.ts` (`#951`).** The atomic write used a **fixed** `<path>.tmp`. In the Action that path is `<workspace>/.opencode/learning.json` — inside the checkout — so a branch can plant a symlink there. `writeFileSync` follows it, redirecting the write; the following `renameSync` does not dereference, so the link *itself* became `learning.json` and `load()` then read through it. `O_CREAT | O_EXCL` is POSIX-defined to fail when a path exists *as a symlink*, which is exactly the guarantee needed. Verified by planting a real symlink and asserting the target is byte-for-byte unchanged.

**#950 reviewed and cleared.** A bot PR rewriting `truncateUtf8Bytes` — the change most likely to hide an off-by-one. Differential-fuzzed against the current implementation over every `maxBytes` from 0 to `byteLength+2`: **806 871 well-formed cases, 0 mismatches, 0 mojibake, 0 budget overruns**. `allocUnsafe` leaks nothing (only `[0, written)` is read) and is strictly better bounded, since the early return means the buffer is always smaller than its input.

> Worth recording about my own process: the **first** fuzz run reported 305 715 "mojibake" hits. That was my corpus — concatenating UTF-16 code units manufactures lone surrogates. Re-run with whole code points, the number is zero. It would have been easy to post that first number as a finding against the PR.

---

## 4b. Round 6: two review findings settled

**#772 C-2 (env stripping) — refuted.** A review said `stripUnsafeSubprocessEnv` "silently drops operator-set env keys" and recommended reverting. It does not: `DEFAULT_MCP_ALLOWED_ENV` *begins* with `PATH`/`HOME`/`NODE_OPTIONS` and none are in `BLOCKED_MCP_ENV_KEYS`, so the parent's values are forwarded and the PR-editable config can only fail to *override* them. `lib/tests/mcp-client.test.ts:663` already asserts `expect(env.PATH).toBe('/usr/bin:/bin')` — the child is shown to get a usable PATH. The review's evidence was the `allowedEnv` test being edited away from `PATH`; that is a different assertion (a PR-editable allowlist must not smuggle credentials), and updating it was correct. **Acting on the review would have removed a real subprocess-hijack control.**

**#853 darwin gap — root cause found and fixed on `main` (#940).** The missing darwin checksums were documented as the *consequence*; the cause was `opencode.ts`'s `platform === 'win32' ? 'zip' : 'tar.gz'`. Upstream publishes no `opencode-darwin-*.tar.gz` at any version, and a missing asset throws, so `setupOpenCode()` **failed outright on macOS** unless opencode was already on `PATH` — the unverified path. Two tests encoded this as intended ("darwin … stays fail-open null"). Fixed, pinned, and both tests corrected.

**Method note:** in both cases the reviewer was reasoning from a comment or a test *name* rather than from the executed code. Reading `KNOWN_CHECKSUMS`'s own comment and the `transportEnv()` assertion settled each in a few minutes where the review had produced the opposite conclusion.

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
8. **Rebuild in the right order before concluding anything about a bundle.**
   My first check built only `@opencode-pr-agent/action`, which bundles the
   *compiled* `lib/dist` — so it was building `main`'s lib output against
   #853's source and appeared to show #853's new code *missing* from the fresh
   build. `pnpm build` builds lib first; only then is the comparison meaningful.
   A wrong build order produced a confident, wrong conclusion in about thirty
   seconds.
9. **A green `pnpm test` says nothing about the shipped bundle.** The action runs
   `action/lib/*.js`, not `lib/src`. #853's stale bundle passed every test in the
   repository.
10. **A subagent's "surviving mutation" needs reproducing before it changes a
   disposition.** Two were reported this way. One (#853) was refuted on the
   first attempt and moved a PR from `NEEDS_TESTS` toward ready. The other
   (#857's `findNpxPackageSpec` URL guard) was not re-checked and is still
   listed as unverified rather than as fact.

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
