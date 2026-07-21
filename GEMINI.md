# OpenCode AI Reviewer — Gemini CLI Guide

## Commands
- `pnpm install` — Install all dependencies
- `pnpm build` — Compile all workspace packages
- `pnpm test` — Run Jest/Vitest unit tests
- `pnpm lint` — Run Biome code style checks
- `pnpm typecheck` — Run TypeScript strict type checks

## Monorepo Layout
| Directory | Purpose |
|-----------|---------|
| `lib/` | Shared core logic (engine, types, helpers) |
| `action/` | GitHub Action wrapper |
| `app/` | Probot GitHub App wrapper |
| `prompts/` | Audit category prompt templates |
| `examples/` | Configuration examples |

## Code Rules
1. **TypeScript only** — no `.js` source files; no `any` type; explicit interfaces everywhere
2. **ESM imports** — all relative imports use `.js` extension
3. **Dependency flow** — `action` and `app` consume `lib`; rebuild after `lib` edits
4. **Biome** for formatting and linting

## Resilience Patterns
- Retry external calls with `withRetry()` (exponential backoff)
- Circuit breaker for repeated API calls
- Graceful degradation for non-critical subsystems
- Structured logging via `Logger`

See `.agents/AGENTS.md` for detailed workspace rules and error resilience patterns.
