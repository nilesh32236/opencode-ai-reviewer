# OpenCode AI Reviewer — Consolidated Design

## Purpose
Merge two existing variants (`github-action-app/`, `opencode-ai-reviewer/`) into a single consolidated monorepo that combines the best of both: MCP integration, Zod validation, Probot app, config file support, multi-model flexibility, reusable workflows, and mature shell scripts (from the VMS project).

## Architecture

```
User workflows / webhooks
        │
        ▼
┌─────────────────────────────────────────────┐
│  action/src/index.ts   or   app/src/index.ts│  ← Thin dispatch layer
└──────────────┬──────────────────────────────┘
               │ calls
               ▼
┌─────────────────────────────────────────────┐
│           lib/src/engine.ts                  │  ← Core orchestrator
│  reviewPR() │ runFix() │ runAudit()          │
└──┬──────┬──────┬──────┬──────┬──────┬───────┘
   │      │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼      ▼
 mcp/  opencode  jsonl  prompts  utils  config
```

## Components

### `lib/` (shared — npm workspace)
| File | Source | Responsibility |
|------|--------|---------------|
| `types/index.ts` | Var 1 | TS interfaces (PRContext, AgentConfig, ReviewResult, etc.) |
| `types/schemas.ts` | Var 1 | Zod schemas for runtime validation |
| `mcp/client.ts` | Var 1 | MCPManager — Context7 + GitHub MCP connections |
| `mcp/servers.ts` | Var 1 | Default MCP server definitions |
| `prompts/builder.ts` | Var 1 | Prompt templates (review/fix/audit) with template sections |
| `utils/github.ts` | Merged | GitHubHelper — raw fetch API, context gathering, reviews, labels |
| `config.ts` | Var 2 | `.opencode-reviewer.yml` loader (YAML-like parser) |
| `engine.ts` | Var 1 | ReviewEngine — orchestrates OpenCode runs, parses output |
| `jsonl-parser.ts` | Var 2 | Resilient JSONL parser (isolated lines, graceful failures) |
| `opencode.ts` | Var 2 | OpenCode CLI setup (`@actions/tool-cache`), execution, git config |

### `action/` (GitHub Action — npm workspace)
- `action.yml` — merged input/output definitions from both variants
- `src/index.ts` — config file load → input parse → mode dispatch
- `src/inputs.ts` — validated input parsing with error messages
- `src/review.ts` — review mode: gather context → build prompt → run OpenCode → post review
- `src/fix.ts` — fix mode: run fix, commit/push, optional auto-merge
- `src/audit.ts` — audit mode: select category → build prompt → run → create issues
- `src/post.ts` — post-action cleanup (placeholder, future use)

### `app/` (GitHub App — npm workspace)
- `src/index.ts` — Probot entry: webhook event routing
- `src/handlers/pr-review.ts` — review on `pull_request.opened/synchronize` + commands
- `src/handlers/autofix.ts` — autofix loop (review → fix → re-review → merge)
- `src/handlers/audit.ts` — audit via label triggers or commands
- `src/handlers/commands.ts` — `/review`, `/fix`, `/audit` slash command processing

### Shell Scripts (from VMS)
- `setup-opencode.sh` — download + install OpenCode binary
- `gather-context.sh` — PR/issue context via GitHub API
- `post-or-update-comment.sh` — idempotent comment updates via marker
- `find-or-create-autofix-pr.sh` — dedup autofix PR creation

### Reusable Workflows
- `.github/workflows/review.yml` — `workflow_call` PR review (outputs: verdict, counts)
- `.github/workflows/autofix.yml` — 3-job loop (review → fix → auto-merge)
- `.github/workflows/audit.yml` — scheduled audit with issue creation

### Key Differences from Originals
- **No duplicate code** — engine, MCP, types shared between action and app
- **No inline curl/jq in TypeScript** — shell scripts handle CLI-only tasks; TypeScript handles API logic
- **Modular prompts** — `prompts/builder.ts` uses sections, not monolithic heredocs
- **Zod at runtime** — validates JSONL output and config, catches errors in CI not at runtime
- **Config file** — `.opencode-reviewer.yml` for per-repo defaults, overridden by action inputs
