---
name: opencode-reviewer-development
description: Guidelines and instructions for developing, building, testing, linting, and configuring the OpenCode AI Reviewer codebase. Trigger on requests related to code review, codebase audits, learning store, event bus, or Monorepo builds.
---

# OpenCode AI Reviewer Development Skill

Use this skill to guide development, debugging, and configuration tasks in the **OpenCode AI Reviewer** workspace.

---

## 1. Project Architecture

This is a `pnpm` monorepo containing three core packages:
1. **`lib/`**: Core TypeScript engine (`ReviewEngine`), SQLite learning store (`LearningStore`), unified `EventBus` and `EventRouter`, MCP client, and prompt builders.
2. **`action/`**: The GitHub Action wrapper that packages the compiled runner via `@vercel/ncc` into `action/lib/index.js`.
3. **`app/`**: The Probot GitHub App server that routes webhooks to the learning store and engine.

---

## 2. Core Constraints & Conventions

### TypeScript & Imports
- ** ESM Extensions in Imports**: Because of Node ESM/CJS compatibility configuration, all TypeScript file imports MUST end with `.js` (e.g. `import { loadConfig } from './config.js';`), NOT `.ts` or omitting extensions.
- **Strict Typing**: Avoid using the `any` type. Define explicit interfaces for configuration inputs, payloads, and events.

### Error Resilience Patterns
- **Retry Utility**: Use `withRetry()` from `lib/src/utils/retry.ts` for all external API calls. It provides exponential backoff with jitter, configurable retry counts, and status code filtering.
- **SQLite Transactions**: Wrap read-then-write operations in `better-sqlite3` transactions using `db.transaction()`. This prevents race conditions in the learning store.
- **Graceful Degradation**: Non-critical subsystems (MCP, learning store) should fail independently without crashing the main review flow.

### Monorepo Build Flow
- **Rebuilding is Mandatory**: The `action` and `app` packages depend on `lib`. If you modify anything inside `lib/src/`, you **must** run `pnpm build` so changes compile and propagate to the wrappers.
- **ncc Bundle**: The GitHub Action runs `action/lib/index.js` compiled by `ncc`. If you modify `action/src/` or `lib/src/`, you must rebuild to update the bundle.

---

## 3. Workflow Commands

Execute these commands from the workspace root using `pnpm`:

- **Install dependencies**: `pnpm install`
- **Rebuild all packages**: `pnpm build`
- **Typecheck all packages**: `pnpm typecheck`
- **Run Vitest unit tests**: `pnpm test`
- **Run linting checks (Biome)**: `pnpm lint`

---

## 4. Configuration & Prompts

### Config File
- Repository configuration resides in `.opencode-reviewer.yml` (e.g., custom review rules, max iterations, project context, audit target directories).
- The action runner loads this file automatically on start using `loadConfig()`.

### Codebase Audits (`.audit-prompts/`)
- Audit categories are defined as markdown prompt templates under `.audit-prompts/` (e.g., `code-quality-conventions.md`, `security-privacy.md`, `error-handling-resilience.md`).
- To create a new audit category:
  1. Add a new `.md` file to `.audit-prompts/` describing what to check.
  2. Add the category name to the `audit.categories` list in `.opencode-reviewer.yml`.
