# Changelog

All notable changes to this project are documented in this file.

---

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
