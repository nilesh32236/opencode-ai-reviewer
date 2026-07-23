# Changelog

All notable changes to this project are documented in this file.

---

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
