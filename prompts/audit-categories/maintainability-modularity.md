# Audit: Maintainability & Modularity

You are auditing a TypeScript monorepo (`lib/` shared core, `action/` GitHub Action front-end, `app/` frozen Probot server, `cli/`, `platform/`) for long-term maintainability. Flag code that works today but will rot: duplication that forces multi-spot edits, oversized units, and missing seams. Do NOT flag anything under `app/` for restructuring (frozen — security fixes only); duplication *into* `app/` from shared code should instead become a `lib/` helper.

## What to Check

### Duplicated Logic (DRY)
- Same or near-same logic in 2+ places that must change together (notably the `action/` ↔ `app/` loop twins: review→fix→verify→push in `action/src/fix.ts` vs `app/src/handlers/autofix.ts`, review paths, audit paths — new shared logic belongs in `lib/`, not a third copy)
- Repeated git/exec/comment-posting sequences across `action/src/*.ts` that should be shared helpers
- Duplicated test mocks/factories across `*/tests/` that belong in a shared factory (see `action/tests/helpers/mock-factories.ts` pattern)
- When flagging, name ALL locations involved so the fix can cover them in one change

### Oversized Units (Split Candidates)
- Functions longer than ~80 lines or files longer than ~800 lines — propose a split point (extract function/module), not just "too long"
- Test files longer than ~1000 lines — propose splits by behavior area
- Functions with 5+ parameters — propose an options object or split
- Deeply nested conditionals (3+ levels) — propose guard clauses or extraction

### Missing Seams & Coupling
- Direct process calls or hard dependencies where an injected adapter/option would allow testing (follow the existing `PlatformAdapter`/`execGit` seam patterns)
- New `lib/` static caches or module-level mutable state without a reset hook for tests (causes order-dependent suites)
- Test files that shadow shared setup but skip its resets
- JSDoc `@param`/`@returns` gaps on exported functions (the docstring-coverage gate enforces this — flag missing ones as minor)

### Dead Weight
- Unused exports, unreachable branches, inputs/options documented in `action.yml` but never read
- Stale cross-references to `app/` in docs for behavior that now lives in `action/`

## What NOT to Flag
- Intentional duplication for fail-open safety where the comment says so
- Generated code (`action/lib/*.js` bundles, `*.d.ts`) — never flag build output
- Cosmetic refactors with no maintenance payoff — every finding must name the future bug it prevents

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Duplicated security logic that can drift apart (permission checks, input validation, secret sanitization, command allowlists)
- **important**: Duplicated business logic in 3+ places, god module/function with a clear split point, untestable direct coupling on a hot path, test isolation leak affecting other suites
- **minor**: 2-spot duplication with an obvious shared home, long-but-cohesive unit, missing shared test factory
