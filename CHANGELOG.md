# Changelog

All notable changes to this project are documented in this file.

---

## [Unreleased] — v1.1.0

### Added
- CONTRIBUTING.md with dev setup, code conventions, and audit category guide
- CHANGELOG.md for release tracking
- Changelog entry template added to release workflow

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

[Unreleased]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.4...HEAD
[v1.0.4]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.3...v1.0.4
[v1.0.3]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.2...v1.0.3
[v1.0.2]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.1...v1.0.2
[v1.0.1]: https://github.com/nilesh32236/opencode-ai-reviewer/compare/v1.0.0...v1.0.1
[v1.0.0]: https://github.com/nilesh32236/opencode-ai-reviewer/releases/tag/v1.0.0
