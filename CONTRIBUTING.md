# Contributing to OpenCode AI Reviewer

Thank you for considering contributing! This document covers how to set up the project, run checks, and submit changes.

## Table of Contents

- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Code Conventions](#code-conventions)
- [Running Tests / Lint / Typecheck](#running-tests--lint--typecheck)
- [Pull Request Process](#pull-request-process)
- [How to Add a New Audit Category](#how-to-add-a-new-audit-category)

---

## Quick Start

**Prerequisites:** Node.js >= 20, pnpm >= 10.8.

```bash
git clone https://github.com/nilesh32236/opencode-ai-reviewer.git
cd opencode-ai-reviewer
pnpm install
pnpm build
pnpm test
```

That's it. You should see all tests pass.

---

## Project Structure

```
├── lib/          # Shared library (types, engine, MCP client, prompt builder, GitHub helpers)
├── action/       # GitHub Action wrapper (consumes lib)
├── app/          # Probot GitHub App wrapper (consumes lib)
├── prompts/      # Audit category prompt templates
├── docker/       # Docker Compose for local dev services
├── docs/         # Additional documentation
├── examples/     # Example workflows
└── .github/      # CI/CD workflows
```

This is a **pnpm monorepo** with three packages (`lib`, `action`, `app`). The `action` and `app` packages depend on `lib`. If you modify `lib`, rebuild all packages with `pnpm build`.

---

## Code Conventions

- **Language:** Strict TypeScript (`.ts`) only. No plain JavaScript in source code.
- **Type Safety:** Avoid `any` at all costs. Define explicit interfaces and types for payloads, configs, and internal data.
- **ESM Imports:** All relative TypeScript imports **must** end with `.js` (e.g. `import { foo } from './bar.js'`). Required by Node.js ESM module resolution.
- **Documentation:** Add JSDoc comments to public functions and configurations.
- **Commit Style:** Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- **Formatting:** The project uses Biome for formatting and linting. Run `pnpm lint` before committing.

---

## Running Tests / Lint / Typecheck

| Command            | Description                        |
| ------------------ | ---------------------------------- |
| `pnpm build`       | Compile all packages recursively   |
| `pnpm test`        | Run all unit tests (Vitest)        |
| `pnpm lint`        | Check code style with Biome        |
| `pnpm lint:fix`    | Auto-fix lint issues               |
| `pnpm format`      | Format code with Biome             |
| `pnpm typecheck`   | Type-check all packages            |

Run these before submitting a PR to make sure CI passes.

---

## Pull Request Process

1. **Create an issue** first describing the bug or feature, or pick an existing one.
2. **Fork the repo** and create a branch from `main` with a descriptive name (e.g. `fix/config-loader`, `feat/new-audit-category`).
3. **Make your changes** following the code conventions above.
4. **Run all verification commands** — `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`.
5. **Open a pull request** against `main`. Link the related issue in the description.
6. **Expect a review.** The project uses AI-assisted review. Address any review feedback with additional commits.

> **Note:** The project uses auto-fix and self-improvement workflows. If your PR introduces lint or type errors, an auto-fix job may trigger.

---

## How to Add a New Audit Category

1. Create a new markdown file in `prompts/audit-categories/` (e.g. `dependency-security.md`).
2. Follow the structure of existing prompts — start with `# Audit: <Category Name>` and include "What to Check" sections.
3. Register the category in `.opencode-reviewer.yml` under `audit.categories`:
   ```yaml
   audit:
     categories:
       - "dependency-security"
   ```
4. Optionally, if you need a custom prompt override, place the file in a directory referenced by `audit.promptsDir` (default: `.audit-prompts`).
5. Rebuild and test: `pnpm build && pnpm test`.
