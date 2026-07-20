# Audit: Code Quality & Conventions

You are auditing the **OpenCode AI Reviewer** codebase — a TypeScript monorepo consisting of:
- `lib/`: The core engine, learning store (SQLite), event-bus, and MCP integrations.
- `action/`: The GitHub Action wrapper.
- `app/`: The Probot GitHub App wrapper.

Focus on checking strict TypeScript compliance, project conventions, and monorepo packaging rules.

Scan the target directories recursively (`lib/src`, `action/src`, `app/src`). Write findings to the output file `.opencode/audit-{category}.jsonl` in JSON Lines format (the prompt builder will pass the correct category).

## What to Check

### TypeScript Strictness & Type Safety
- **No `any` usage**: Avoid using the `any` type unless absolutely necessary. Look for explicit, strong interfaces for payloads, configuration schemas, and data structures. If `any` is used, it should have a Biome suppression comment explaining why.
- **Strict type checking**: Verify types are correctly defined and there are no type assertions (`as any` or `as unknown` when unnecessary). TypeScript's `strict: true` is enabled in `tsconfig.json`.
- **TypeScript files**: All source files must be TypeScript (`.ts`). No pure JavaScript (`.js`) files in `src/` directories.
- **Null/undefined safety**: Check for proper null checks (using `??` or `?.`) rather than loose truthiness checks that could mask bugs. Look for patterns like `if (value)` where `value` could be `0` or `''` legitimately.

### Import Path Conventions
- **ESM Extensions**: Due to Node ESM requirements, TS file imports from other TS files MUST end with `.js` extensions (e.g. `import { EventBus } from './bus.js'`). Check that local imports do not omit `.js` or (worse) use `.ts`. This is a **critical** finding.
- **Index imports**: Barrel imports from `index.ts` files should use explicit named imports (e.g. `import { LearningStore } from './store.js'`), not `import * as` patterns that increase bundle size.

### Monorepo Dependency Flow
- **Decoupled Engine**: The core logic inside `lib/` must remain decoupled from `action/` and `app/` wrappers. `action` and `app` depend on `lib`, not vice versa.
- **Build Synchronization**: If files in `lib/` are modified, the packages must be rebuilt. Verify that `action/lib/index.js` and `lib/dist/` are built correctly and up-to-date.
- **Cross-package imports**: Imports between workspace packages should use the workspace protocol (`"@opencode-pr-agent/lib": "workspace:*"`), not relative paths or version ranges.

### Code Style & Documentation
- **JSDoc documentation**: Public functions, configuration fields, and modules should have standard JSDoc comments describing parameters and return values.
- **Linting & Formatting**: Follow code conventions enforced by Biome (spaces 2 indent, single quotes, semicolons always). Run `pnpm lint` to verify.
- **Unused code**: Check for dead code, commented-out blocks, or imports that are no longer used. In test files, verify that all imports are actually referenced.

### Error & Boundary Patterns
- **Early returns**: Functions that validate inputs should use early returns, not deeply nested `if` blocks.
- **Consistent return types**: Functions should return consistent types — not `string | null` in one path and `string` in another without good reason. Check `recordFinding` returning `string | null`.
- **Async function signatures**: Async functions should always return a `Promise<T>`, never `void` in a sync manner.

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Structural bugs, invalid import paths (e.g. using `.ts` in ESM imports), monorepo boundary crossings (`lib` importing from `action` or `app`), major type bypasses (e.g. `any` without suppression comment), unreachable catch clauses.
- **important**: Missing JSDoc comments for public APIs, redundant type assertions, code style violations (like tabs, double quotes, missing semicolons), undocumented functions, inconsistent return types across a single function.
- **minor**: Minor style drifts, TODO/FIXME comments without associated issue numbers, unused imports that don't affect runtime.
