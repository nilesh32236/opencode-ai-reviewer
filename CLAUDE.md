# OpenCode AI Reviewer — Claude Code Guide

## Quick Start
```bash
pnpm install    # Install dependencies
pnpm build      # Compile all packages
pnpm test       # Run unit tests
pnpm lint       # Check code style (Biome)
pnpm typecheck  # TypeScript type checking
```

## Project Structure
This is a `pnpm` monorepo with three packages:
- `lib/` — Shared core logic (engine, types, helpers)
- `action/` — GitHub Action wrapper (consumes `lib`)
- `app/` — Probot GitHub App wrapper (consumes `lib`)

## Coding Conventions
- **Language:** Strict TypeScript (`.ts`) only, no plain JS
- **Type Safety:** No `any` — define explicit interfaces
- **ESM Imports:** All relative imports must end with `.js` (e.g., `import { foo } from './bar.js'`)
- **Dependency Flow:** `action` and `app` depend on `lib` — rebuild after `lib` changes
- **Formatting:** Biome (`pnpm lint` before commits)
- **Documentation:** JSDoc for public functions

## Error Resilience
- Use `withRetry()` from `lib/src/utils/retry.ts` for external API calls
- Use `CircuitBreaker` from `lib/src/utils/circuit-breaker.ts` for repeated calls
- Wrap SQLite read-then-write in transactions (`better-sqlite3`)
- Non-critical subsystems (MCP, learning store) should degrade gracefully
- Use `Logger` from `lib/src/utils/logger.ts` for structured logging

See `.agents/AGENTS.md` for full workspace rules and error resilience patterns.
