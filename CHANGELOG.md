# Changelog

All notable changes to this project are documented in this file.

---

## [v1.11.0] — 2026-08-13

### Added

- restore scheduled workflows (daily audit, weekly self-improvement, hourly orchestrator)

### Changed

- chore: remove opencode-related workflows, hosted App handles event-driven review

[v1.11.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.8...v1.11.0

## [v1.10.8] — 2026-08-13


### Fixed

- exclude private-key.pem from rsync and git to prevent --delete removal

[v1.10.8]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.7...v1.10.8

## [v1.10.7] — 2026-08-13


### Fixed

- boot app as Probot server in Docker (probot run) for App mode

### Changed

- [Autofix] [Audit:performance-efficiency] 2 critical, 7 important, 1 minor (#384) (#384)

[v1.10.7]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.6...v1.10.7

## [v1.10.6] — 2026-08-13


### Fixed

- skip action/cli builds in Docker image to avoid ncc OOM

[v1.10.6]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.5...v1.10.6

## [v1.10.5] — 2026-08-13


### Fixed

- install ca-certificates in Docker build for HTTPS downloads

[v1.10.5]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.4...v1.10.5

## [v1.10.4] — 2026-08-13


### Fixed

- install docker compose v2 plugin in EC2 deployment

[v1.10.4]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.3...v1.10.4

## [v1.10.3] — 2026-08-13


### Fixed

- use native SSH for EC2 deployment

### Changed

- ci: add EC2 deployment workflow (#386) (#386)

[v1.10.3]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.2...v1.10.3

## [v1.10.2] — 2026-08-12


### Fixed

- recognize opencode-go provider, graceful post-processing, audit prompt name, git identity
- address issue #380 [skip ci] (#381) (#380
#381)

### Changed

- ⚡ Bolt: Optimize truncateUtf8Bytes allocation overhead (#382) (#382)

[v1.10.2]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.1...v1.10.2

## [v1.10.1] — 2026-08-11


### Fixed

- remove invalid secrets expression from action.yml description

### Changed

- [Self-Improvement] Autonomous Codebase Enhancement (#379) (#379)
- fix(ci): add missing JSDoc params breaking doc:check on main

[v1.10.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.10.0...v1.10.1

## [v1.10.0] — 2026-08-11

### Added

- merge-readiness score + repository rules & commit context in review prompts
- add opencode_api_key input + OPENCODE_API_KEY env forwarding

### Fixed

- address verification findings (finding identity, single-flight coalescing, per-agent streaming)
- address verification findings (all-batches-failed caching, reasoning, repo-keyed upserts)
- preserve markdown fences inside JSONL string values
- stream findings in multi-agent mode; finalize stream-progress marker
- resolveFixedComments keys on message, not line coordinates
- make postOrUpdateComment race-free under concurrent webhooks
- never green-light an unreviewed PR (all batches failed -> ready:false)
- feedback/dismissal correctness (bot self-dispute, file-only scope, comment_id, thread dismissal)
- serialize concurrent review events per PR in the app subscriber
- failed streamed inline posts no longer drop the finding
- make dedup skip a first-class no-op instead of no meaningful content
- don't cache failed reviews; avoid unhandled rejection on dedup cleanup
- dedup cache no longer kills autofix loop or manual /review

### Changed

- Merge pull request #378 from nilesh32236/improve/review-comments-and-quality
- test: add postStreamingProgress mock to pr-review handler tests

[v1.10.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.9.3...v1.10.0

## [v1.9.3] — 2026-08-11


### Fixed

- treat empty-string repo as non-dedup context in review guard
- deduplicate concurrent and repeated ReviewEngine review runs
- make signal handlers idempotent and non-terminating in lib

[v1.9.3]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.9.2...v1.9.3

## [v1.9.2] — 2026-08-10


### Fixed

- wait for conversation cleanup before close
- paginate pull request files
- reject option-like git refs
- consolidate JSON database exit listeners
- serialize concurrent state cache saves
- preserve GitLab retry-after headers

### Changed

- chore: rebuild action bundle for shutdown lifecycle
- docs: align GitLab adapter JSDoc
- chore: verify SQLite transaction boundaries
- chore: rebuild action bundle for PR pagination
- chore: rebuild action bundle for ref validation
- chore: clean strict source diagnostics
- chore: verify package logic parity
- chore: audit workflow diagnostics
- ci: validate orchestrator branch refs
- ci: avoid duplicate self-heal dispatches
- ci: cache pnpm in autonomous workflows
- chore: inventory workflow invariants
- chore: rebuild action bundle for JSON database lifecycle
- chore: rebuild action state cache bundle
- chore: rebuild action bundle
- chore: verify circuit breaker state transitions
- test: fix setup secret environment isolation
- docs: plan setup secret fixture fix
- docs: add conservative autonomous audit plan

[v1.9.2]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.9.1...v1.9.2

## [v1.9.1] — 2026-08-09


### Fixed

- command injection via unvalidated PR head branch name

### Changed

- Merge pull request #377 from nilesh32236/sentinel/command-injection-fix-6297593707538227482
- Merge remote-tracking branch 'origin/main' into sentinel/command-injection-fix-6297593707538227482

[v1.9.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.9.0...v1.9.1

## [v1.9.0] — 2026-08-09

### Added

- add health/readiness probes for the Probot app (issue #179)
- streaming review comments — post findings as batches complete (issue #190)

### Fixed

- benchmark adapter streaming methods; explicit catch typing; merge main
- complete JSDoc for streaming methods in LocalAdapter
- add streaming methods to LocalAdapter for PlatformAdapter compatibility
- preserve parsed accuracyScore of 0 instead of FP-rate fallback
- report -1 accuracy score when FP rate is unknown (issue #185)

### Changed

- Merge pull request #372 from nilesh32236/fix/issue-190-streaming
- Merge remote-tracking branch 'origin/main' into fix/issue-190-streaming
- Merge pull request #370 from nilesh32236/bolt-cluster-optimization-3271668728549648341
- Merge remote-tracking branch 'origin/main' into bolt-cluster-optimization-3271668728549648341
- Merge pull request #376 from nilesh32236/fix/issue-179-health
- Merge pull request #371 from nilesh32236/fix/issue-185-meta-review
- Merge pull request #375 from nilesh32236/fix/issue-180-adr
- Merge pull request #374 from nilesh32236/fix/issue-181-bolt-md
- Merge pull request #373 from nilesh32236/fix/issue-183-readme-analyze
- docs: add architecture decision records for key design decisions (issue #180)
- docs: add file:line references to bolt.md optimization claims (issue #181)
- docs: add analyze mode to quick-start highlights (issue #183)

### Performance

- Use optimized tokenizeMessage and jaccardSimilarity in cluster.ts

[v1.9.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.8.5...v1.9.0

## [v1.8.5] — 2026-08-08


### Fixed

- address issue #367 [skip ci]
- address issue #191 [skip ci] (#365) (#191
#365)

### Changed

- Merge pull request #369 from nilesh32236/autofix/issue-367

[v1.8.5]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.8.4...v1.8.5

## [v1.8.4] — 2026-08-08


### Fixed

- escape backslashes before backticks in title suggestion (CodeQL incomplete-escaping)
- address PR #364 review findings — config plumbing, retry/breaker, scope & title fixes (#366) (#364
#366)
- address issue #192 [skip ci] (#364) (#192
#364)
- address issue #193 [skip ci] (#362) (#193
#362)

### Changed

- Merge pull request #368 from nilesh32236/clean/codeql-escape
- [Autofix] Implement incremental learning from dismissal feedback loop (#361) (#361)
- [Autofix] Issue 34: No test gap detection or test suggestion capability (#359) (#359)

[v1.8.4]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.8.3...v1.8.4

## [v1.8.3] — 2026-08-07


### Fixed

- self-heal CI failure (attempt 1) [lint-error — biome style violations (import ordering + formatting) in `action/src/fix.ts`, `app/src/handlers/autofix.ts`, and `lib/src/utils/validation.ts`. the ci run also showed the `build lib` step canceled, but this was a transient concurrency cancellation (`cancel-in-progress: true`); the build itself compiles cleanly.] (#360) (#360)

### Changed

- revert: drop pinned checksum entry — opencode_version uses latest automatically
- fix(action): support cd && chains in run_checks_after_fix; skip ci on autofix commits

[v1.8.3]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.8.2...v1.8.3

## [v1.8.2] — 2026-08-06


### Fixed

- self-heal CI failure (attempt 1) [lint-error (jsdoc docstring coverage violation)] (#358) (#358)

### Changed

- [Autofix] Issue 38: No dependency vulnerability (SCA) checking (#357) (#357)
- [Autofix] Add custom LLM model hosting support (#356) (#356)

[v1.8.2]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.8.1...v1.8.2

## [v1.8.1] — 2026-08-06


### Fixed

- address issue #198 (#355) (#198
#355)

[v1.8.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.8.0...v1.8.1

## [v1.8.0] — 2026-08-06

### Added

- add documentation generation capability for changed code (#354) (#354)

### Changed

- fix(review): resolve PR #350 review findings in optimized modules (#353) (#350
#353)
- docs: add comprehensive project roadmap with key milestones (#352) (#352)
- [Self-Heal] Fix CI failure in CI (Check performance budgets) (#351) (#351)
- feat(performance): comprehensive optimizations for codebase indexing and pattern detection (#350) (#350)
- [Autofix] Add multi-agent review architecture with specialized agents (#349) (#349)

[v1.8.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.7.1...v1.8.0

## [Unreleased]

### Added

- add `/docs` command to generate documentation comments for code changed in a PR and open a documentation PR; supports `docs.style`/`docs.enabled` config and a `docs` action mode with `docs_model`/`docs_style` inputs (#199)

---

## [v1.7.1] — 2026-08-05


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint (jsdoc plugin) docstring coverage errors failing the ci "verify docstring coverage" step (`pnpm doc:check`).] (#348) (#348)

[v1.7.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.7.0...v1.7.1

## [v1.7.0] — 2026-08-05

### Added

- add secret/credential detection utility (#198) (#198)

### Fixed

- address bugs #186, #187, #188 reported in audit

### Changed

- Merge branch 'fixes/audit-and-bugs'
- fix(review): address CodeRabbit follow-up findings on PR #347
- Audit security fixes + bug fixes #186 #187 #188 + secret detection (#198) (#347) (#186
#187
#188
#198
#347)
- merge: main into fixes/audit-and-bugs (resolve bundle conflicts)
- fix(builder): pre-cap codebase index so instruction tail survives
- fix(review): address CodeRabbit + review-agent findings on PR #347
- [Autofix] Add Slack/Teams notification integration for review summaries (#346) (#346)
- fix(audit): security hardening per deep audit findings

[v1.7.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.40...v1.7.0

## [v1.6.40] — 2026-08-05


### Fixed

- address follow-up review feedback for issue #202 (#345) (#202
#345)

[v1.6.40]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.39...v1.6.40

## [v1.6.39] — 2026-08-05


### Fixed

- address issue #178 (structured logging & correlation IDs) (#343) (#178
#343)

[v1.6.39]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.38...v1.6.39

## [v1.6.38] — 2026-08-05


### Fixed

- address issue #202 (branch protection as required status check) (#344) (#202
#344)

[v1.6.38]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.37...v1.6.38

## [v1.6.37] — 2026-08-04


### Fixed

- address issue #177 (#342) (#177
#342)

[v1.6.37]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.36...v1.6.37

## [v1.6.36] — 2026-08-04


### Fixed

- address issue #176 (#341) (#176
#341)

### Changed

- [Autofix] Binary .node file committed in action/lib/build/Release/better_sqlite3.node (#340) (#340)

[v1.6.36]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.35...v1.6.36

## [v1.6.35] — 2026-08-04


### Fixed

- address issue #173 (#339) (#173
#339)

### Changed

- [Autofix] MCP servers receive GITHUB_TOKEN and API keys as environment variables (#338) (#338)

[v1.6.35]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.34...v1.6.35

## [v1.6.34] — 2026-08-04


### Fixed

- address issue #169 (#337) (#169
#337)

[v1.6.34]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.33...v1.6.34

## [v1.6.33] — 2026-08-04


### Fixed

- address issue #206 (#336) (#206
#336)

[v1.6.33]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.32...v1.6.33

## [v1.6.32] — 2026-08-04


### Fixed

- address issue #331 — MCP opt-in, sanitization, audit slug, safe autofix branch reuse (#332) (#331
#332)

[v1.6.32]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.31...v1.6.32

## [v1.6.31] — 2026-08-04


### Fixed

- self-heal CI failure (attempt 1) [lint-error] (#335) (#335)

### Changed

- [Autofix] [Audit:code-quality-conventions] 0 critical, 10 important, 0 minor (#334) (#334)
- [Autofix] Issue 36: No interactive PR chat / follow-up question capability (#330) (#330)

[v1.6.31]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.30...v1.6.31

## [Unreleased]

### Breaking Changes

- Removed the `parseReviewOutput` helper and `ParsedReviewOutput` type from the public `@opencode-pr-agent/lib` surface. They were dead code (no in-repo consumers) superseded by the canonical `parseJsonlString` / `parseJsonlFile` parsers.

---

## [v1.6.30] — 2026-08-02


### Fixed

- address issue #207 (#329) (#207
#329)

### Changed

- [Autofix] Add CLI tool for local review outside of CI/CD (#328) (#328)
- [Autofix] CONTRIBUTING.md references non-existent scripts (#327) (#327)
- [Autofix] Issue 31: No language-specific review strategies (#326) (#326)

[v1.6.30]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.29...v1.6.30

## [v1.6.29] — 2026-08-02


### Fixed

- address issue #215 (#325) (#215
#325)

### Changed

- [Autofix] No validation that OpenCode model string is correct before running (#324) (#324)
- [Autofix] Docker Compose file missing environment variables for full functionality (#323) (#323)
- [Autofix] Issue 27: No commit history or git blame awareness in reviews (#322) (#322)
- [Autofix] Issue 30: Meta-verification uses same model as review, amplifying model biases (#321) (#321)

[v1.6.29]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.28...v1.6.29

## [v1.6.28] — 2026-08-02


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — jsdoc/eslint docstring coverage violations (`jsdoc/require-returns`, `jsdoc/require-param`) failing the `verify docstring coverage` ci step (`pnpm doc:check`).] (#319) (#319)

### Changed

- [Autofix] No tests for JSONL parser edge cases (#320) (#320)
- [Autofix] Issue 26: No codebase indexing - only diff context is used for review (#315) (#315)

[v1.6.28]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.27...v1.6.28

## [v1.6.27] — 2026-08-02


### Fixed

- address issue #317 (#318) (#317
#318)

### Changed

- [Self-Improvement] Autonomous Codebase Enhancement (#316) (#316)

[v1.6.27]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.26...v1.6.27

## [v1.6.26] — 2026-08-01


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint `jsdoc/require-param` **errors** in the `ci` → `verify docstring coverage` step (`pnpm doc:check`).] (#313) (#313)

### Changed

- [Autofix] 77: No graceful degradation when OpenCode CLI is not available or version mismatch (#314) (#314)
- [Autofix] Issue 29: No threshold tuning or per-repository sensitivity configuration (#312) (#312)

[v1.6.26]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.25...v1.6.26

## [v1.6.25] — 2026-08-01


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint `jsdoc/require-param` **error** in the `ci` → `verify docstring coverage` step (`pnpm doc:check`).] (#310) (#310)

### Changed

- [Autofix] 78: Event bus system is defined but underutilized (#311) (#311)
- fix(setup): pass authenticated token to setupOpenCode to prevent anonymous rate limits
- fix(review): allow manual triggers to bypass skipLabels and load skipLabels from config
- [Autofix] 79: The 'conversation' mode lacks conversation history and context window management (#309) (#309)
- fix(workflow): add ref input and dynamic ref resolution for issue_comment triggers

[v1.6.25]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.24...v1.6.25

## [v1.6.24] — 2026-08-01


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint `jsdoc` rule violations in the `ci` → `verify docstring coverage` step (`pnpm doc:check`).] (#308) (#308)

### Changed

- [Autofix] 80: No rate limiting for the Probot app to prevent abuse or cost runaway (#307) (#307)
- [Autofix] No token usage / cost tracking exposed to users (#306) (#306)
- [Autofix] No dismiss/feedback mechanism with reason tracking on PR comments (#305) (#305)
- [Autofix] No onboarding wizard or setup validation tool (#304) (#304)
- [Autofix] No diff size / review budget handling for very large PRs (#303) (#303)

[v1.6.24]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.23...v1.6.24

## [v1.6.23] — 2026-08-01


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint `jsdoc/require-param` violations in the ci "verify docstring coverage" step (`pnpm doc:check`).] (#302) (#302)

### Changed

- [Autofix] [Audit:api-data-fetching] 2 critical, 5 important, 6 minor (#301) (#301)
- fix(orchestrator): fix hourly orchestrator PR conflict resolution, AI QA answering, and fix-issue workflow dispatch triggers
- [Autofix] No performance benchmarks or CI performance regression tests (#299) (#299)

[v1.6.23]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.22...v1.6.23

## [v1.6.22] — 2026-07-31


### Fixed

- address issue #224 (#298) (#224
#298)

[v1.6.22]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.21...v1.6.22

## [v1.6.21] — 2026-07-31


### Fixed

- address issue #234 (#297) (#234
#297)

[v1.6.21]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.20...v1.6.21

## [v1.6.20] — 2026-07-31


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint `jsdoc/require-jsdoc` violations in the ci "verify docstring coverage" step (`pnpm doc:check`).] (#296) (#296)

[v1.6.20]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.19...v1.6.20

## [v1.6.19] — 2026-07-31


### Fixed

- address issue #242 (#295) (#242
#295)

### Changed

- [Autofix] Issue 23: action.yml 'mode' description is incomplete - missing 'analyze' mode (#294) (#294)

[v1.6.19]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.18...v1.6.19

## [v1.6.18] — 2026-07-31


### Fixed

- address issue #248 (#293) (#248
#293)

### Changed

- [Autofix] Issue 20: app/src/index.ts is a 500+ line single module handling all subscribers (#291) (#291)

[v1.6.18]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.17...v1.6.18

## [v1.6.17] — 2026-07-31


### Fixed

- address issue #288 (#290) (#288
#290)

[v1.6.17]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.16...v1.6.17

## [v1.6.16] — 2026-07-31


### Fixed

- address issue #171 (#289) (#171
#289)

### Changed

- fix(action): apply autofix label when creating PRs from issues and self-heal

[v1.6.16]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.15...v1.6.16

## [v1.6.15] — 2026-07-31


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint/jsdoc rule violations (verify docstring coverage step)] (#287) (#287)
- support /fix --force to auto-answer blocking questions and proceed
- address issue #168 (#286) (#168
#286)

[v1.6.15]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.14...v1.6.15

## [v1.6.14] — 2026-07-30


### Fixed

- self-heal CI failure (attempt 1) [**`lint-error`** — eslint `jsdoc/require-jsdoc`, `jsdoc/require-param`, and `jsdoc/require-returns` violations in the `pnpm doc:check` step.] (#285) (#285)

### Changed

- [Autofix] Add IaC scanning for Dockerfiles, Terraform, K8s manifests (#284) (#284)
- [Autofix] Issue 39: No GitLab Merge Request support (#283) (#283)

[v1.6.14]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.13...v1.6.14

## [v1.6.13] — 2026-07-30


### Fixed

- remove unsupported type field from workflow_call outputs

[v1.6.13]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.12...v1.6.13

## [v1.6.12] — 2026-07-30


### Fixed

- self-heal CI failure (attempt 1) [lint-error (eslint `jsdoc/require-param` rule)] (#282) (#282)
- address issue #209 (#281) (#209
#281)
- address issue #214 (#279) (#214
#279)
- address issue #219 (#278) (#219
#278)

### Changed

- [Autofix] Issue 28: No reachability analysis for security findings (#280) (#280)
- [Autofix] 76: Separate 'review' and 'fix' model configuration is too coarse-grained (#277) (#277)

[v1.6.12]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.11...v1.6.12

## [v1.6.11] — 2026-07-30


### Fixed

- self-heal CI failure (attempt 1) [lint-error (jsdoc docstring coverage)] (#276) (#276)

### Changed

- [Autofix] Unbounded comment fetching in conversation handler (#275) (#275)

[v1.6.11]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.10...v1.6.11

## [v1.6.10] — 2026-07-30


### Fixed

- address issue #240 (#274) (#240
#274)

[v1.6.10]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.9...v1.6.10

## [v1.6.9] — 2026-07-30


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint jsdoc rule violations (`jsdoc/require-param`, `jsdoc/require-returns`)] (#272) (#272)

### Changed

- [Autofix] No smart token budgeting — all files get equal context regardless of complexity (#273) (#273)
- [Autofix] No existing linter/formatter bridge for hybrid analysis (#271) (#271)

[v1.6.9]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.8...v1.6.9

## [v1.6.8] — 2026-07-30


### Fixed

- address issue #243 (#270) (#243
#270)

[v1.6.8]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.7...v1.6.8

## [v1.6.7] — 2026-07-30


### Fixed

- address issue #245 (#268) (#245
#268)

[v1.6.7]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.6...v1.6.7

## [v1.6.6] — 2026-07-30


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — eslint jsdoc coverage violations (`jsdoc/require-jsdoc`, `jsdoc/require-returns`, `jsdoc/require-param`)] (#269) (#269)

### Changed

- [Autofix] Issue 20: app/src/index.ts is a 500+ line single module handling all subscribers (#267) (#267)
- [Autofix] MCP disconnect timeout has unguarded non-null assertion (#266) (#266)

[v1.6.6]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.5...v1.6.6

## [v1.6.5] — 2026-07-30


### Fixed

- remove type:module from lib, use export type * from, inline DEFAULT_CONFIG and schemas

### Changed

- chore: rebuild compiled output with ncc 0.44.1
- ⚡ Bolt: Optimize JSON database file I/O with debounced async writes (#261) (#261)
- [Autofix] Issue 61: No review analytics dashboard or accuracy metrics tracking (#252) (#252)

[v1.6.5]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.4...v1.6.5

## [v1.6.4] — 2026-07-30


### Fixed

- self-heal CI failure (attempt 1) [lint-error] (#264) (#264)

### Changed

- [Autofix] [Audit:security-privacy] 1 critical, 4 important, 3 minor (#257) (#257)

[v1.6.4]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.3...v1.6.4

## [v1.6.3] — 2026-07-30


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — missing jsdoc annotations violated the `jsdoc/require-param` and `jsdoc/require-returns` rules.] (#263) (#263)
- address issue #235 (#253) (#235
#253)
- self-heal CI failure (attempt 1) [**no failure detected** — all ci steps pass cleanly.] (#262) (#262)
- address issue #170 (#247) (#170
#247)
- self-heal CI failure (attempt 1) [**runtime-error** — unhandled `typeerror` during mcp client connection teardown.] (#260) (#260)

### Changed

- fix(action): resolve @opencode-pr-agent/lib module resolution in action vitest and workflows
- fix(self-heal): extract relevant error traceback snippet from CI logs for prompt context
- [Autofix] parseInt without NaN guard for pr-number input in fix mode (#251) (#251)
- fix(ci): attempt immediate PR squash merge before falling back to --auto
- fix(self-heal): prevent E2BIG argument list error and declare self-heal action inputs
- chore(ci): upgrade all workflow actions to absolute latest major versions (checkout@v7, setup-node@v7, action-setup@v6, codeql@v4, gh-release@v3)
- chore(ci): upgrade setup-node to v5, action-setup to v4, and bump Node versions to 22/24
- perf(ci): check for existing heal PR before Node setup & dependency installation
- fix(deps): update engines.node range to >=20.0.0 to support Node 20+
- fix(ci): repair hourly-orchestrator parameter expansion & self-heal opencode setup script
- [Autofix] No integration tests for the critical review-to-comment pipeline (#254) (#254)

[v1.6.3]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.2...v1.6.3

## [v1.6.2] — 2026-07-30


### Fixed

- address issue #258 (#259) (#258
#259)

[v1.6.2]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.1...v1.6.2

## [v1.6.1] — 2026-07-29


### Fixed

- self-heal CI failure (attempt 1) [`lint-error` — missing/incomplete jsdoc docstrings caught by `eslint-plugin-jsdoc` in the `doc:check` step.] (#255) (#255)

[v1.6.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.6.0...v1.6.1

## [v1.6.0] — 2026-07-29

### Added

- add self-healing CI and enhanced self-improvement workflows (fixes #165)

### Fixed

- address all PR review comments

### Changed

- feat(workflow): add Hourly Autonomous Orchestrator workflow (.github/workflows/hourly-orchestrator.yml)
- fix(review): address review feedback on self-healing PR

[v1.6.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.5.5...v1.6.0

## [v1.5.5] — 2026-07-29


### Fixed

- address issue #174 (#250) (#174
#250)
- address issue #189 (#231) (#189
#231)

[v1.5.5]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.5.4...v1.5.5

## [v1.5.4] — 2026-07-29

### Fixed

- Resolve false-positive blocking questions parsing, strip question prefixes cleanly, and handle mixed-content sections (#161, #163, #164)
- Auto-clear `analysis:needs-input` label and mark `analysis:ready` when maintainers reply to blocking questions (#161, #164)
- Align comment marker detection in `gatherContext` for CRLF and whitespace resilience (#161, #164)
- ReDoS security refactoring for answer parsing regexes (#163, #164)

[v1.5.4]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.5.3...v1.5.4

## [v1.5.3] — 2026-07-29


### Fixed

- resolve auto-analyze bullet parsing and enforce immediate fix deferral on questions (#158) (#158)

[v1.5.3]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.5.2...v1.5.3

## [v1.5.1] — 2026-07-26


### Fixed

- address issue #117 (#151) (#117
#151)

[v1.5.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.5.0...v1.5.1

## [v1.5.0] — 2026-07-26

### Added

- Review workflow, issue analysis, question gating & PR quality enhancements (#150) (#150)

### Changed

- ⚡ Bolt: Pre-compile regular expressions in detectIntent (#148) (#148)
- [Self-Improvement] Autonomous Codebase Enhancement (#147) (#147)

[v1.5.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.4.0...v1.5.0

## [v1.4.0] — 2026-07-26

### Added

- capture and persist token usage & execution telemetry in LearningStore (#146) (#146)

[v1.4.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.3.0...v1.4.0

## [v1.2.0] — 2026-07-25

### Added

- Enhanced learning feedback, interactive agent, delta reviews, and meta-verification (#145) (#145)

[v1.2.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.19...v1.2.0

## [v1.1.19] — 2026-07-25


### Fixed

- address issue #115 (#143) (#115
#143)

### Changed

- [Autofix] Issue 4: Expand Manifest-Based Library Detection for Python, Java, Ruby, and .NET (#142) (#142)

[v1.1.19]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.18...v1.1.19

## [v1.1.18] — 2026-07-25


### Fixed

- address issue #113 (#141) (#113
#141)

[v1.1.18]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.17...v1.1.18

## [v1.1.17] — 2026-07-25


### Fixed

- pass AbortSignal to EventBus subscribers, increase timeout, improve fix prompt with project context

[v1.1.17]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.16...v1.1.17

## [v1.1.16] — 2026-07-24


### Fixed

- ensure API keys are forwarded to OpenCode CLI and output directory exists in analyze mode

### Changed

- ⚡ Bolt: Use Promise.all for pattern rule creation (#139) (#139)

[v1.1.16]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.15...v1.1.16

## [v1.1.15] — 2026-07-24


### Fixed

- address issue #112
- address issue #111 (#135) (#111
#135)
- comprehensive code audit — 35+ critical and important fixes (#137) (#137)

### Changed

- Merge branch 'main' into autofix/issue-112
- refactor: centralize command allowlist and add database migration testing support
- 🛡️ Sentinel Daily Guard: Prevent command injection in autofix handler (#134) (#134)

[v1.1.15]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.14...v1.1.15

## [v1.1.14] — 2026-07-23


### Fixed

- address issue #126 (#133) (#126
#133)

[v1.1.14]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.13...v1.1.14

## [v1.1.13] — 2026-07-23


### Fixed

- address issue #125 (#132) (#125
#132)

### Changed

- [Autofix] Issue 13: Implement `runAnalyze()` Method in `ReviewEngine` (#131) (#131)
- [Autofix] Issue 12: Add `analyze` Mode, `AnalyzeResult` Types, and `buildAnalyzePrompt()` with Architectural Prompt Engineering (#130) (#130)

[v1.1.13]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.12...v1.1.13

## [v1.1.12] — 2026-07-23


### Fixed

- address issue #121 (#129) (#121
#129)

[v1.1.12]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.11...v1.1.12

## [v1.1.11] — 2026-07-23


### Fixed

- address issue #120 (#128) (#120
#128)

[v1.1.11]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.10...v1.1.11

## [v1.1.10] — 2026-07-23


### Fixed

- address issue #119 (#127) (#119
#127)

### Changed

- [Autofix] Set Up Automated Docstring Coverage Checker and Enforce 80% Threshold in CI (#122) (#122)
- [Autofix] [Audit:error-handling-resilience] 1 critical, 7 important, 5 minor (#110) (#110)
- [Autofix] Issue 12: Add Symbolic Link Guard and Path Traversal Verification to Prompt Loader (#108) (#108)

[v1.1.10]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.9...v1.1.10

## [v1.1.9] — 2026-07-22


### Fixed

- address issue #95 (#107) (#95
#107)

### Changed

- [Autofix] Issue 10: Implement Application-Layer Concurrent Batch Processing and Synthesis (#106) (#106)

[v1.1.9]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.8...v1.1.9

## [v1.1.8] — 2026-07-22


### Fixed

- address issue #93 (#105) (#93
#105)

### Changed

- [Autofix] Issue 8: Workspace Isolation for Concurrent Probot Webhook Events (#104) (#104)
- [Autofix] Issue 7: Implement Compiler/Test Error Feedback Loop in Autofix Mode (#103) (#103)

[v1.1.8]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.7...v1.1.8

## [v1.1.7] — 2026-07-22


### Fixed

- address issue #90 (#102) (#90
#102)

[v1.1.7]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.6...v1.1.7

## [v1.1.6] — 2026-07-22


### Fixed

- address issue #89 (#101) (#89
#101)
- address issue #88 (#100) (#88
#100)

### Changed

- [Autofix] Issue 3: Implement Client-Side MCP Tool Whitelisting and Verification (#99) (#99)
- [Autofix] Issue 2: Implement State Persistence and Sync for the Learning Store in CI (#98) (#98)
- [Autofix] Issue 1: Refactor` JsonDatabase` to Avoid Regex-Based SQL Parsing (#97) (#97)
- Optimize pattern finding file type extraction in PatternDetector (#84) (#84)
- [Self-Improvement] Autonomous Codebase Enhancement (#83) (#83)

[v1.1.6]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.5...v1.1.6

## [v1.1.5] — 2026-07-22


### Fixed

- address issue #81 (#82) (#81
#82)

### Changed

- [Autofix] [Audit:code-quality-conventions] 3 critical, 7 important, 7 minor (#80) (#80)
- 🛡️ Sentinel Guard: Redact tokens from logs and PR comments (#78) (#78)

[v1.1.5]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.4...v1.1.5

## [v1.1.4] — 2026-07-21


### Fixed

- address issue #74 (#77) (#74
#77)

[v1.1.4]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.3...v1.1.4

## [v1.1.3] — 2026-07-21


### Fixed

- address issue #75 (#76) (#75
#76)

[v1.1.3]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.2...v1.1.3

## [v1.1.2] — 2026-07-21


### Fixed

- address issue #71 (#72) (#71
#72)

### Changed

- [Autofix] [v1.4] Verify integrity of downloaded OpenCode CLI (#70) (#70)
- [Autofix] [v1.4] Add configurable command allowlist for post-fix checks (#69) (#69)

[v1.1.2]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.1...v1.1.2

## [v1.1.1] — 2026-07-21

### Fixed
- Address issue #41 (#63)
- Address issue #40 (#62)
- Address issue #39 (#61)

### Changed
- [Autofix] [v1.4] Create automated release workflow (#68)
- [Autofix] [v1.3] Add inline review suggestions mode (#67)
- [Autofix] [v1.3] Ship built-in CI workflows in .github/workflows/ (#66)
- [Autofix] [v1.3] Add per-path and per-branch config overrides (#65)
- [Autofix] [v1.3] Implement remote MCP server support (#64)

[v1.1.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.1.0...v1.1.1

## [v1.1.0] — 2026-07-21

### Added
- Full test suites for config loader (254 lines), MCP client (399 lines), DB adapter (639 lines), GitHub helpers (932 lines), engine (542 lines), and OpenCode client (369 lines)
- CONTRIBUTING.md with dev setup, code conventions, and audit category guide
- CHANGELOG.md for release tracking
- Real `createAutofixPR` implementation in the GitHub App — creates branches, applies fixes, creates PRs via GitHub API, links PRs back to issues
- `getDefaultBranch()` and `createPR()` helpers on `GitHubHelper`
- Performance-efficiency audit auto-fixes: LRU prepared-statement cache (configurable), MCP tools caching, batched pattern recording, parallelized queries, missing index on `review_quality.created_at`
- Code-quality-conventions audit auto-fixes: error sanitization, config validation, graceful degradation, consistent logging
- Jaccard similarity optimization (~6x speedup) with zero-allocation set operations and hoisted regex constants
- Changelog entry template added to release workflow

### Fixed
- MCP `connect()` re-initialization guard — prevents redundant transport processes in autofix loop
- Branch existence check in autofix flow — resolves `origin/` remote ref instead of local branch name
- Autofix label attachment to newly created PRs
- JSON DB adapter fragility (addressing issue #34)
- Config loader edge cases (addressing issue #35)
- Address issue #54 across MCP client, learning store, schema, and pattern detector

### Changed
- `SqliteAdapter` cache size made configurable via constructor (`maxCacheSize` parameter)
- Pattern recording uses batch inserts within a single transaction
- `prepareStmt` uses LRU eviction instead of FIFO

### Performance
- Zero-allocation Jaccard similarity in `PatternDetector.clusterFindings` — no temporary Sets or Arrays
- Regex constants hoisted to module scope in cluster.ts
- MCP tool listing cached after first fetch per client
- Parallel `COUNT(*)` queries in `getFalsePositiveRate`

---

## [v1.0.4] — 2026-07-20

### Fixed
- Ensure action exits reliably by awaiting transport.close and calling process.exit on all paths
- Address issue #31 — autofix iteration fixes
- Address issue #28 — upgrade closeOpenCodePRs failure logging from debug to warning with details
- Prevent action hanging on timeout with SIGKILL fallback and wall-clock guard

### Changed
- Refactor function signatures and module imports in index.js to support modularized execution logic

---

## [v1.0.3] — 2026-07-19

### Added
- Configurable timeouts and graceful timeout handling (PR #26)

---

## [v1.0.2] — 2026-07-19

### Fixed
- Compile baseBranch fix
- Bump version to 1.0.2

---

## [v1.0.1] — 2026-07-19

### Added
- Auto-tag `latest` on every stable release
- Audit-driven auto-fixes for error-handling-resilience (PR #21)
- Audit-driven auto-fixes for security-privacy (PR #24)
- Autonomous codebase enhancement workflow (PR #22)

### Fixed
- PHP directory library detection

---

## [v1.0.0] — 2026-07-17

### Added
- Initial release of OpenCode AI Reviewer
- PR review mode with diff extraction, file batching, and sub-agent review
- Auto-fix mode with iterative verification loop (lint/test/typecheck)
- Codebase audit mode with configurable categories
- GitHub Action wrapper (action/)
- Probot GitHub App wrapper with webhook listeners (app/)
- Shared core library (lib/) with:
  - Config parsing and validation
  - OpenCode API client
  - JSONL parser for structured review output
  - MCP client and server infrastructure for context enrichment
  - EventBus and EventRouter for unified event dispatch
  - LearningStore with SQLite persistence
  - MetaReview subsystem with quality scoring and prompt overrides
  - PatternDetector with clustering and rule approval
  - FeedbackSubscriber for learning from review dismissals
- CI/CD workflows (CI, release, review, auto-fix, audit, self-improvement)
- Biome linting and formatting
- Docker Compose for local development services
- Comprehensive audit category prompts (code quality, security, error handling, performance)

[v1.1.0]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.4...v1.1.0
[v1.0.4]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.3...v1.0.4
[v1.0.3]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.2...v1.0.3
[v1.0.2]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.1...v1.0.2
[v1.0.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.0...v1.0.1
[v1.0.0]: https://github.com/nilesh32236/opencode-ai-reviewer/releases/tag/v1.0.0
