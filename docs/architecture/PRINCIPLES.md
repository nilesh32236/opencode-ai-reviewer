# Architecture Principles

Baseline for the `opencode-ai-reviewer` monorepo (packages: `lib`, `action`, `app`, `cli`, `platform`).
These principles are descriptive of what the codebase already does and prescriptive for future changes.

## 1. SOLID, DRY, composition over inheritance

- Single-responsibility modules: one file owns one domain concept
  (e.g. `lib/src/utils/secret-detect.ts` owns secret detection, nothing else).
- Depend on narrow interfaces (`PlatformAdapter`, `ReviewEngine` options types),
  not concrete classes, at package seams.
- Prefer small composable functions (`withRetry`, `sanitizeString`, `buildXPrompt`)
  over base classes or god-objects. `lib/src/engine.ts` (6590 lines) is the
  known violation and the primary decomposition target — not the pattern to copy.

## 2. Explicit dependency boundaries

- Allowed: `action` / `app` / `cli` / `platform` → `lib` (via the
  `@opencode-pr-agent/lib` package specifier only; no relative `../../lib` imports).
- Forbidden: `lib` → any wrapper package. `lib` must build, typecheck, and test
  with zero knowledge of its consumers.
- Wrappers are thin adapters: parse inputs, call `lib`, format outputs.
  Business logic that two wrappers need belongs in `lib`.

## 3. Small, focused modules

- New files should do one thing and stay reviewable in a single sitting
  (few hundred lines, not thousands).
- Split at responsibility boundaries (orchestration vs. batching vs. output
  formatting), never at arbitrary line ranges.
- Re-export facades (`index.ts` barrels) preserve import stability when
  internals move.

## 4. Security-first: never weaken a boundary to simplify

- The files in `BOUNDARIES.md` (allowlists, destructive-fix ceiling, path
  confinement, SSRF guards, ref/SHA/slug validation, secret redaction,
  prompt-injection wrapping, fail-closed privilege gates, restricted envs)
  are load-bearing. A refactor that makes them simpler but weaker is a regression.
- Fail closed: unknown actor, unparseable ref, unlisted command → deny.
- Untrusted input (PR titles/bodies/comments, config from the PR checkout) is
  sanitized at the boundary, not at the point of use.

## 5. Ratcheting guardrails

- Conventions already at zero stay at zero: `0` occurrences of `as any` in `src`,
  ESM `.js`-suffixed relative imports, `vitest` everywhere, JSDoc (`doc:check`).
- New code follows the existing convention without being asked:
  `withRetry` for network/child-process calls, sanitized logging (never raw secrets),
  typed exports over casts.
- If a guardrail regresses, fixing it is part of the change that caused it.

## 6. One responsibility per change

- One issue / PR = one responsibility: one package, one domain, one reason to revert.
- Refactors carry no behavior change; behavior changes carry no refactors.
- New discoveries made mid-change become queue items, not scope creep
  (see `REFACTORING-RULES.md`).
