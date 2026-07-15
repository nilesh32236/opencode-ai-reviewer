# OpenCode AI Reviewer — Workspace Rules for AI Agents

Welcome! When working in this repository, please adhere to the following rules, structures, and commands to maintain consistency and quality.

## Project Structure & Architecture

This repository is a `pnpm` monorepo containing three core packages:

1. **[lib/](file:///home/nilesh/Documents/projects/github-action/lib/)**: Shared core logic (types, config parsing, OpenCode API interaction, Probot/GitHub helpers, and sub-agent loop engine).
2. **[action/](file:///home/nilesh/Documents/projects/github-action/action/)**: The GitHub Action wrapper that consumes `lib` and runs in GitHub workflows.
3. **[app/](file:///home/nilesh/Documents/projects/github-action/app/)**: The Probot GitHub App wrapper that listens to PR/issue events and interacts with users via PR comments.

Other directories:
- **[prompts/](file:///home/nilesh/Documents/projects/github-action/prompts/)**: Built-in prompts for audit categories.
- **[examples/](file:///home/nilesh/Documents/projects/github-action/examples/)**: Configuration examples (basic, monorepo, advanced).
- **[docker/](file:///home/nilesh/Documents/projects/github-action/docker/)**: Docker Compose configs for running local servers/services.

---

## Coding Conventions

- **Language**: TypeScript (`.ts`) is strictly required. No pure JavaScript for source code.
- **Type Safety**: Avoid using `any` unless absolutely necessary. Write explicit interfaces for all payloads, config schemas, and internal data transfers.
- **ESM Imports**: All relative TypeScript imports MUST end with `.js` extension (e.g., `import { foo } from './bar.js'`). This is required by Node.js ESM module resolution.
- **Dependency Flow**: The `action` and `app` packages depend on `lib`. If you modify anything inside `lib`, you **must** rebuild the packages for changes to propagate.
- **Documentation**: Keep code comments and docstrings intact. If adding functions or modules, write standard JSDoc comments.

## Error Resilience Patterns

When writing or reviewing code in this repository, follow these patterns:

1. **Use `withRetry()` for external API calls**: Import from `lib/src/utils/retry.ts`. All GitHub API calls should use this utility for exponential backoff and retry on transient errors (429, 5xx). Supports optional `AbortSignal` via the `signal` option for cancellation.
2. **Use `CircuitBreaker` for repeated API calls**: Import from `lib/src/utils/circuit-breaker.ts`. Wrap external API calls that should stop being attempted after repeated failures. The circuit trips OPEN after `failureThreshold` failures, re-tries after `cooldownMs`, and requires `successThreshold` consecutive successes in HALF_OPEN to reset.
3. **Wrap SQLite read-then-write in transactions**: Use `db.transaction()` from `better-sqlite3` for operations that read a value, compute, and then write (e.g., `recordPattern`, `incrementAndCheckMetaReviewInterval`). The `LearningStore.deleteFindings()` automatically uses a transaction to cascade-delete related feedback rows.
4. **Graceful degradation**: Non-critical subsystems (MCP, learning store) should fail independently. Catch and log (debug/warning level) rather than silently swallowing errors, so degraded operation remains observable.
5. **Timeouts for long-running operations**: Always pass a timeout to long-running operations, especially OpenCode CLI execution. Use `withRetryAndTimeout()` from `lib/src/utils/retry.ts` for operations that need both timeout and retry.
6. **Use `Logger` for structured logging**: Import from `lib/src/utils/logger.ts`. Provides log levels (debug/info/warn/error), structured context (PR number, repo, event type), and outputs via `@actions/core` in GitHub Actions environments.
7. **GitHub API pagination**: Use the `paginate` method on `GitHubHelper` when fetching list endpoints. The helper also tracks `X-RateLimit-Remaining` headers and warns when approaching the limit.
8. **EventBus lifecycle**: The `EventBus` supports `register()`, `registerAll()`, and `unregister()` for subscriber lifecycle management. Use `getSubscriberHealth()` to inspect subscriber failures and `resetHealth()` to clear metrics.

---

## Workflow Commands

Always execute the following commands using `pnpm`:

### Dependencies Setup
```bash
pnpm install
```

### Build Workspace
To compile TypeScript files across all monorepo packages:
```bash
pnpm build
```

### Type Checking
To typecheck all workspace packages (useful after code changes to ensure compatibility):
```bash
pnpm typecheck
```

### Testing
To run Jest/Vitest unit tests:
```bash
pnpm test
```

### Linting
To run ESLint and check format/style:
```bash
pnpm lint
```

---

## Verification Checklist
Before completing any task, ensure that:
1. All files pass type-checking: `pnpm typecheck`
2. All packages compile successfully: `pnpm build`
3. All tests pass: `pnpm test`
4. The code is clean of linting warnings/errors: `pnpm lint`
