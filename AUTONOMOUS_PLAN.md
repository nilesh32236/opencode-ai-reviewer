# Autonomous Audit Plan

This manifest is processed top-to-bottom. Every item requires evidence, a
targeted check, the full workspace gates, and a dedicated conventional commit.
Items are intentionally conservative: autonomous review, fix, and merge
authority must remain unchanged.

## [CRITICAL_BUGS]

- [x] Fix setup-secret test isolation so a configured non-OpenCode model without its required provider key fails setup, while retaining coverage for OpenCode/local provider exceptions. Root cause: assigning `undefined` to `process.env` coerced values to the string `"undefined"`; the fixture now deletes all recognized provider variables. Verification: targeted setup suite passed (40/40), `pnpm build`, `pnpm typecheck`, `pnpm test` (1,810 passed, 1 skipped), and `pnpm lint` (exit 0; one pre-existing warning).
- [x] Audit `CircuitBreaker` state transitions under concurrent half-open calls and verify failure/success counters cannot allow premature closure or probe leaks. Evidence: `call()` transitions and guards are synchronous before the awaited operation; the existing 14 circuit-breaker tests cover CLOSED/OPEN/HALF_OPEN transitions, thresholds, hooks, and reset behavior, with no reproducible defect found. Verification: targeted circuit suite passed (14/14), plus full build, typecheck, test (1,810 passed, 1 skipped), and lint (exit 0; one pre-existing warning). No code change required.
- [x] Audit external API retry and rate-limit handling for unbounded delays, duplicate retries, or missing circuit protection. Verified defect: `GitLabAdapter.api()` did not preserve response headers on HTTP errors, so shared retry handling could not honor `Retry-After`; fixed by attaching `res.headers` and adding regression coverage. Remaining GitHub/OpenCode/notifier call sites use bounded retry and timeout paths. Verification: GitLab suite passed (108/108), full build, typecheck, test (1,811 passed, 1 skipped), and lint (exit 0; one pre-existing warning).
- [ ] Audit `StateCacheManager` restore/save behavior for cache-key collisions, stale mtime decisions, and concurrent save races. Evidence required from implementation review and regression tests before changing code. Targeted gate: `action` state-cache tests.
- [ ] Audit process listener lifecycle and MCP/event subscriber cleanup after the baseline `MaxListenersExceededWarning`. Change only if a reproducible leak or unsafe lifecycle is confirmed. Targeted gate: affected lib tests.

## [WORKFLOWS]

- [ ] Inventory all workflow triggers, permissions, concurrency groups, checkout/setup steps, and reusable-workflow contracts. Record verified redundancies and invariants without changing merge authority. Targeted gate: YAML parse/static validation.
- [ ] Consolidate safe Node/pnpm setup and dependency caching across eligible workflows without changing runtime versions, lockfile policy, or trigger behavior. Targeted gate: YAML validation plus workflow contract review.
- [ ] Prevent duplicate scheduled/self-heal/autofix work only where concurrency groups or event filters demonstrably overlap; preserve existing review, fix, labels, and merge routes. Targeted gate: YAML validation and trigger-matrix review.
- [ ] Harden workflow shell inputs and failure propagation where untrusted refs, issue content, model input, or command output can alter execution. Preserve intended autonomous behavior and avoid broad shell rewrites. Targeted gate: YAML static review and relevant tests.
- [ ] Improve workflow diagnostics and artifact/cache behavior where failures currently become silent or unverifiable. Targeted gate: YAML validation and relevant package tests.

## [REFACTORING]

- [ ] Audit `action`, `app`, and `cli` for duplicated shared logic that belongs in `lib`; refactor only concrete duplication with existing test coverage. Targeted gate: affected package tests.
- [ ] Audit strict TypeScript and ESM import compliance across all workspace source files; fix verified violations without generated-file churn. Targeted gate: `pnpm typecheck` and `pnpm lint`.
- [ ] Audit GitHub API pagination, retry, timeout, and structured logging call sites against workspace resilience rules. Targeted gate: affected lib/app/action tests.
- [ ] Audit SQLite read-then-write operations for transaction boundaries and add regression coverage for confirmed races. Targeted gate: learning-store tests.
- [ ] Audit public functions and configuration interfaces for missing JSDoc or weak types, fixing only actionable gaps. Targeted gate: `pnpm doc:check` and `pnpm typecheck`.
