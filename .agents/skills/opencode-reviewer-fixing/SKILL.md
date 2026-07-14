---
name: opencode-reviewer-fixing
description: Guidelines and instructions for fixing issues, codebase bugs, and audit findings in the OpenCode AI Reviewer repository. Trigger this skill when fixing failing tests, resolving typescript compile errors, addressing security issues, or resolving audit findings.
---

# OpenCode AI Reviewer Fixing & Self-Healing Skill

Use this skill to guide the agent when fixing codebase bugs, responding to issue comments (`/fix`), resolving audit findings, or addressing compilation/test failures.

---

## 1. Analyzing Issues & Audit Findings

When addressing audit findings or issues:
- **Reference specific paths and lines**: Locate the exact file and line numbers specified in the audit log or issue description.
- **Understand the underlying rule**: Review `.audit-prompts/` markdown templates to understand why a finding is flagged as a violation (e.g. strict type safety, shell escapes, DB lock handling).

---

## 2. Context Verification (Context7 & Web Search)

### Context7 Documentation (Mandatory for libraries & APIs)
- **Always verify library versions**: When modifying library logic, ORMs, Probot, Vitest, or actions SDK, fetch the latest documentation via Context7.
- **How to call**: Use the Context7 MCP server tools (like `resolve` or `docs`) or run the Context7 CLI:
  - Find the library ID: `npx ctx7@latest library <name> "<question>"`
  - Query the docs: `npx ctx7@latest docs <libraryId> "<question>"`
- *Never assume cached documentation is up-to-date, especially for rapidly evolving Node/TS libraries.*

### Web Search (For general debugging)
- **Research errors**: If a test or build command fails with a cryptic message, use the `search_web` tool to search for matching GitHub issues, stackoverflow threads, or package release notes.
- **Verification of best practices**: Use web search to check for deprecation warnings or standard patterns when writing Node or GitHub Action wrappers.

---

## 3. Applying Fixes

### ESM Imports
- Ensure all relative TS/JS imports end with a `.js` extension due to Node ESM compilation rules (e.g., `import { setupOpenCode } from './opencode.js'`).

### Decoupled Logic
- Apply engine changes inside the `lib/` package first.
- Keep Action wrapper changes inside the `action/` package, and Probot handlers inside the `app/` package.

---

## 4. Verification Workflow

Before considering any fix complete, the agent MUST run these verification commands from the workspace root:

1. **Workspace setup**: Run `pnpm install` if dependencies are changed or missing.
2. **Rebuild**: Run `pnpm build`. (Crucial if changing code in `lib/` so that the compiler propagates changes to `action/` and `app/` builds).
3. **Typecheck**: Run `pnpm typecheck` to verify no TS errors are introduced.
4. **Unit Tests**: Run `pnpm test` to run Vitest suites. Ensure 100% test pass rate.
5. **Lint**: Run `pnpm lint` to check Biome formatting.
