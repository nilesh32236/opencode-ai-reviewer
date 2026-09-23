# Refactoring Rules

Applies to every structural change, especially the decomposition of hotspots
(`lib/src/engine.ts` 6590 lines, `lib/src/utils/github.ts` 3793,
`lib/src/opencode.ts` 3718, `lib/src/types/index.ts` 2744,
`lib/src/utils/jev-client.ts` 2173, `lib/src/config.ts` 1806,
`lib/src/prompts/builder.ts` 1799).

## 1. One responsibility per issue / PR

- A refactor PR touches one responsibility boundary (e.g. "extract batching
  from the engine"), in one package, with one reason to revert.
- Never mix behavior changes, feature work, or releases into a refactor PR.
- The PR description states the responsibility being moved and the facade
  that preserves compatibility.

## 2. Split at responsibility boundaries, never arbitrary line ranges

- Extract by cohesion: orchestration vs. batching vs. verification vs. MCP vs.
  prompts vs. verdicts vs. output formatting vs. git ops — not "lines 1–800".
- Each extracted module gets a name that states its responsibility and an
  export surface limited to what consumers need (`grep '^export'` should stay
  small and intentional).
- Hotspot inventory with current responsibilities: see `class-inventory.json`.

## 3. Preserve compatibility facades

- Existing import paths keep working: leave re-export barrels / facades at the
  old location until all consumers migrate, then remove in a separate change.
- Public package exports (`@opencode-pr-agent/lib` surface consumed by the
  four wrappers) do not change shape during a refactor.

## 4. No release / public-API changes inside refactors

- No version bumps, no changelog entries beyond "internal refactor", no new
  inputs/outputs/options, no changed defaults.
- If an API improvement suggests itself mid-refactor, file it as a queue item
  and keep the refactor behavior-identical.

## 5. New discoveries become queue items, not scope creep

- Finding adjacent rot (a second god-function, a missing test, a weak error
  path) does not expand the current PR. Record it (file, lines, one-line
  why) and continue.
- The queue lives with the refactor plan; each item later becomes its own
  one-responsibility change under these same rules.

## 6. Deterministic verification per change

Every refactor PR must report, per touched package:

1. `pnpm --filter <pkg> build` — passes.
2. `pnpm --filter <pkg> typecheck` — passes.
3. `pnpm --filter <pkg> test` (vitest) — passes, including the regression
   tests for any touched security-boundary file (see `BOUNDARIES.md`).
4. `pnpm lint` / `doc:check` for touched files — clean (`as any` count in
   `src` stays `0`, JSDoc intact, ESM `.js` relative imports intact).

If any step cannot run, the PR says exactly which step was skipped and why —
never a blanket "verified".
