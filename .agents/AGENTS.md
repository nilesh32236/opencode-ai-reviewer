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
- **Dependency Flow**: The `action` and `app` packages depend on `lib`. If you modify anything inside `lib`, you **must** rebuild the packages for changes to propagate.
- **Documentation**: Keep code comments and docstrings intact. If adding functions or modules, write standard JSDoc comments.

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
