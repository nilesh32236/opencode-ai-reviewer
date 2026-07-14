# Audit: Code Quality & Conventions

You are auditing the **OpenCode AI Reviewer** codebase — a TypeScript monorepo consisting of:
- `lib/`: The core engine, learning store (SQLite), event-bus, and MCP integrations.
- `action/`: The GitHub Action wrapper.
- `app/`: The Probot GitHub App wrapper.

Focus on checking strict TypeScript compliance, project conventions, and monorepo packaging rules.

Scan the target directories recursively (`lib/src`, `action/src`, `app/src`). Output findings to `.audit-output.jsonl`.

## What to Check

### TypeScript Strictness & Type Safety
- **No `any` usage**: Avoid using the `any` type unless absolutely necessary. Look for explicit, strong interfaces for payloads, configuration schemas, and data structures.
- **Strict type checking**: Verify types are correctly defined and there are no type assertions (`as any` or `as unknown` when unnecessary).
- **TypeScript files**: All source files must be TypeScript (`.ts`). No pure JavaScript (`.js`) files in `src/` directories.
- **Null/undefined safety**: Check for proper null checks (using `??` or `?.`) rather than loose truthiness checks that could mask bugs.

### Import Path Conventions
- **ESM Extensions**: Due to Node ESM requirements, TS file imports from other TS files MUST end with `.js` extensions (e.g. `import { EventBus } from './bus.js'`). Check that local imports do not omit `.js` or use `.ts`.

### Monorepo Dependency Flow
- **Decoupled Engine**: The core logic inside `lib/` must remain decoupled from `action/` and `app/` wrappers. `action` and `app` depend on `lib`, not vice versa.
- **Build Synchronization**: If files in `lib/` are modified, the packages must be rebuilt. Verify that `action/lib/index.js` and `lib/dist/` are built correctly and up-to-date.

### Code Style & Documentation
- **JSDoc documentation**: Public functions, configuration fields, and modules should have standard JSDoc comments describing parameters and return values.
- **Linting & Formatting**: Follow code conventions enforced by Biome (spaces 2 indent, single quotes, semicolons always).

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Structural bugs, invalid import paths (e.g. using `.ts` in ESM imports), monorepo boundary crossings, major type bypasses (e.g. `any` without lint ignore).
- **important**: Missing JSDoc comments for public APIs, redundant type assertions, code style violations (like tabs, double quotes, missing semicolons), and undocumented functions.
- **minor**: Minor style drifts, TODO/FIXME comments without associated issue numbers.
