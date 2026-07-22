# OpenCode AI Reviewer

AI-powered PR review, auto-fix, and codebase audit — as a GitHub Action and a GitHub App (Probot).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![PNPM](https://img.shields.io/badge/Package%20Manager-pnpm-orange.svg)](https://pnpm.io/)
[![Architecture Guide](https://img.shields.io/badge/Architecture-Agentic-purple.svg)](agent.md)
[![Contributing](https://img.shields.io/badge/Contributing-CONTRIBUTING.md-brightgreen.svg)](CONTRIBUTING.md)
[![Changelog](https://img.shields.io/badge/Changelog-CHANGELOG.md-blue.svg)](CHANGELOG.md)

- **Review** PRs for bugs, security issues, and style problems.
- **Auto-fix** issues iteratively using compiler and test errors.
- **Audit** an entire codebase and file GitHub issues for findings.

Uses OpenCode models (`opencode/deepseek-v4-flash-free`) by default; also supports OpenAI, Anthropic, and Gemini.

For details on the agent's internal architecture, execution loops, and prompt designs, refer to the [Architecture & Design Guide](agent.md).

---

## Quick Start — GitHub Action

### Option A: Shipped Reusable Workflow (Recommended)

No files to copy. Create `.github/workflows/ai-review.yml` with a single job that calls the shipped reusable workflow:

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    uses: nilesh32236/opencode-ai-reviewer/.github/workflows/review.yml@v1
    secrets: inherit
```

The following reusable workflows are shipped with the action:

| Workflow | Description | Usage |
|----------|-------------|-------|
| `review.yml` | AI-powered PR review | `uses: nilesh32236/opencode-ai-reviewer/.github/workflows/review.yml@v1` |
| `audit.yml` | Full codebase audit | `uses: nilesh32236/opencode-ai-reviewer/.github/workflows/audit.yml@v1` |
| `autofix.yml` | Review → fix → auto-merge loop | `uses: nilesh32236/opencode-ai-reviewer/.github/workflows/autofix.yml@v1` |

All shipped workflows are production-ready with timeouts, concurrency guards, and zero-config defaults — the GitHub Token is auto-inherited via `secrets: inherit`. See [examples/basic/review.yml](examples/basic/review.yml) and [examples/advanced/ai-suite.yml](examples/advanced/ai-suite.yml) for ready-to-copy templates that compose these reusable workflows.

### Option B: Direct Action Usage

Create `.github/workflows/pr-review.yml` for full control over every input:

```yaml
name: OpenCode PR Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v6
      - uses: nilesh32236/opencode-ai-reviewer@v1
        with:
          mode: review
          github_token: ${{ secrets.GITHUB_TOKEN }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

The Action runs `review` mode by default. Other modes: `fix`, `audit`, `post`, `pr-review`.

---

## Configuration Reference

| Input                    | Default                              | Description                                    |
| ------------------------ | ------------------------------------ | ---------------------------------------------- |
| `mode`                   | `review`                             | One of: `review`, `fix`, `audit`, `post`, `pr-review` |
| `github_token`           | _(required)_                         | GitHub token for API access                    |
| `openai_api_key`         | —                                    | OpenAI API key                                 |
| `anthropic_api_key`      | —                                    | Anthropic API key                              |
| `gemini_api_key`         | —                                    | Google Gemini API key                          |
| `review_model`           | `opencode/deepseek-v4-flash-free`    | Model for PR review                            |
| `fix_model`              | `opencode/deepseek-v4-flash-free`    | Model for auto-fix                             |
| `audit_model`            | `opencode/deepseek-v4-flash-free`    | Model for codebase audit                       |
| `review_prompt_file`     | —                                    | Path to custom review prompt file              |
| `review_prompt_extra`    | —                                    | Extra context appended to the review prompt    |
| `enable_fix`             | `true`                               | Enable auto-fix mode                           |
| `max_fix_iterations`     | `3`                                  | Max review-fix cycles                          |
| `enable_audit`           | `false`                              | Enable codebase audit                          |
| `audit_target_dir`       | —                                    | Directory to audit                             |
| `max_files_per_batch`    | `3`                                  | Files per sub-agent batch                      |
| `max_lines_per_file`     | `500`                                | Max lines per file included in context         |
| `project_context`        | —                                    | Project description for review prompts         |
| `enable_mcp`             | `true`                               | Enable MCP servers for context enrichment      |
| `include_strengths`      | `true`                               | Include positive feedback in output            |
| `review_comment_summary` | `true`                               | Post a summary comment on the PR               |
| `review_inline`          | `true`                               | Post findings as inline review comments on the PR diff (set to `false` for summary-only)
| `run_checks_after_fix`   | —                                    | Commands to run after fix (e.g. `npm run lint`) |
> **Security:** Commands are validated against an allowlist (`fix.checkAllowlist` in `.opencode-reviewer.yml`, default `[pnpm, npm, yarn, node]`) to prevent shell injection. Add only trusted programs to the allowlist.
| `audit_prompt_file`      | —                                    | Path to custom audit prompt file               |
| `audit_create_issues`    | `true`                               | Create GitHub issues for audit findings        |
| `audit_auto_fix`         | `false`                              | Auto-trigger fixes for audit findings          |
| `audit_labels`           | `audit`                              | Comma-separated labels for audit issues        |
| `enable_state_cache`     | `true`                               | Persist the learning database across runs using GitHub Actions Cache |
| `state_cache_key`        | `opencode-learning-state`            | Custom key prefix for the learning state cache |

**Outputs:** `review_summary`, `verdict`, `critical_count`, `important_count`, `minor_count`, `changes_made`.

### Inline Review Mode

By default (`review_inline: true`), the reviewer posts findings as inline comments on the specific lines of the PR diff. Each inline comment includes:

- The issue severity label (`CRITICAL`, `IMPORTANT`, or `MINOR`)
- The issue message
- A suggestion (if provided), with a ````suggestion```` diff block for multi-line fixes

Findings that cannot be mapped to a diff line (e.g., global issues, file-level findings without a specific line) are included in the summary comment.

Set `review_inline: false` in your workflow inputs or `.opencode-reviewer.yml` (`review.inline: false`) to disable inline comments and post all findings as a single summary comment instead.

#### Config via `.opencode-reviewer.yml`

```yaml
review:
  inline: true    # or false for summary-only
```

#### Per-path overrides

```yaml
overrides:
  - path: "packages/legacy/**"
    review:
      inline: false    # summary-only for legacy code
```

### Fix Configuration

Configure auto-fix behavior and verification commands:

```yaml
fix:
  maxIterations: 3
  runChecks:
    - "pnpm typecheck"
    - "pnpm lint"
  checkAllowlist:
    - pnpm
    - node
    - cargo
    - make
```

The `checkAllowlist` option controls which programs are allowed in `runChecks`. Commands using programs outside the allowlist are skipped with a warning. Default: `[pnpm, npm, yarn, node]`. This prevents shell injection from untrusted configuration sources — only add programs you trust.

---

## MCP Server Configuration

The reviewer uses MCP (Model Context Protocol) servers for context enrichment. Both local (stdio) and remote (HTTP SSE) servers are supported.

### Local Servers

```yaml
# .opencode-reviewer.yml
mcpServers:
  - name: context7
    type: local
    command: ['npx', '-y', '--quiet', '@upstash/context7-mcp']
    environment:
      CONTEXT7_API_KEY: ${CONTEXT7_API_KEY}
    timeoutMs: 5000    # optional, default 5000ms
```

### Remote Servers

```yaml
# .opencode-reviewer.yml
mcpServers:
  - name: my-remote-mcp
    type: remote
    url: https://mcp.example.com/sse
    environment:
      Authorization: Bearer ${MCP_AUTH_TOKEN}
      X-API-Key: ${MCP_API_KEY}
    timeoutMs: 10000   # optional, default 5000ms
```

Remote servers use SSE transport. Environment variables are passed as HTTP headers for authentication. See `lib/src/mcp/servers.ts` for pre-configured server definitions.

---

## State Persistence & Remote Database

### Learning State Cache (GitHub Actions)

When running as a GitHub Action, the learning database (`.opencode/learning.db`) lives on an ephemeral runner and is lost after each workflow run. To preserve learnings across runs, the action automatically saves and restores the `.opencode/` directory using the [GitHub Actions Cache](https://github.com/actions/cache).

- **Cache scope:** per-branch (keyed by `{state_cache_key}-{owner}/{repo}-{branch}`)
- **Fallback restore:** if no exact branch match exists, the most recently created cache entry across all branches in this repository will be used as a warm start
- **Disabled by:** setting `enable_state_cache: false` in your workflow inputs

### Remote Database (Distributed Environments)

For environments where caching is not viable — or when running across multiple runners — you can supply a persistent database connection string via the `DATABASE_URL` environment variable:

```yaml
- uses: nilesh32236/opencode-ai-reviewer@v1
  with:
    mode: review
    github_token: ${{ secrets.GITHUB_TOKEN }}
  env:
    DATABASE_URL: postgresql://user:password@host:5432/opencode_reviews
```

Supported database backends (in priority order):

| Scheme | Driver | Notes |
|--------|--------|-------|
| `postgres://` / `postgresql://` | `pg` | Full-featured SQL |
| `mysql://` | `mysql2` | Full-featured SQL |
| File path (e.g. `/data/learning.db`) | `better-sqlite3` | Default; uses cache for persistence |
| (no URL / missing driver) | JSON file fallback | Graceful degradation |

When `DATABASE_URL` is set, the learning store connects directly to the remote database, bypassing the file-based cache entirely. This is the recommended approach for production deployments that require durable learning across distributed workflows.

---

## GitHub App (Probot)

The App listens for webhooks and works like the Action but runs as a hosted service.

### Setup

1. Create a GitHub App at **Settings > Developer settings > GitHub Apps**.
   Use the permissions from [`app/app.yml`](app/app.yml):
   - Pull requests: **write**
   - Issues: **write**
   - Contents: **write**
   - Metadata: **read**
2. Subscribe to events: `pull_request`, `pull_request_review_comment`, `issue_comment`, `issues`, `label`.
3. Generate a **private key** and note your **App ID**.
4. Configure environment variables (or a `.env` file):

```
APP_ID=<your-app-id>
PRIVATE_KEY_PATH=/path/to/pem
GITHUB_TOKEN=<token>
OPENAI_API_KEY=<key>
WEBHOOK_SECRET=<secret>
```

5. Run the app:

```bash
pnpm --filter @opencode-pr-agent/app build
pnpm --filter @opencode-pr-agent/app start
```

For local development with a tunnel, use [smee.io](https://smee.io):

```bash
npx smee --url https://smee.io/<your-channel> --path /api/webhook --port 3000
```

The app listens for these commands in PR/issue comments:
- `/review` or `/oc` — trigger a review
- `/fix` — trigger auto-fix
- `/audit` — trigger codebase audit

---

## Development

```bash
pnpm install                # install all workspace dependencies
pnpm build                  # build all packages (lib -> action, app)
pnpm test                   # run all tests
pnpm lint                   # run ESLint across packages
pnpm typecheck              # type-check all packages
pnpm setup:local            # start local Docker services (see docker/)
pnpm teardown:local         # stop local Docker services
```

### Project Structure

```
├── lib/                    # Shared library (types, engine, MCP client, prompt builder, GitHub helper)
│   └── src/
│       ├── config.ts       # Agent configuration & validation
│       ├── engine.ts       # Review/audit/fix engine
│       ├── opencode.ts     # OpenCode API client
│       ├── jsonl-parser.ts # JSONL parsing utilities
│       ├── mcp/            # MCP server integrations
│       ├── prompts/        # Built-in review/audit/fix prompts
│       ├── types/          # Shared TypeScript types
│       └── utils/          # Helpers (GitHub, file I/O, etc.)
├── action/                 # GitHub Action (consumes lib)
│   └── src/
│       ├── index.ts        # Action entry point
│       ├── inputs.ts       # Input parsing
│       ├── review.ts       # Review mode handler
│       ├── fix.ts          # Fix mode handler
│       ├── audit.ts        # Audit mode handler
│       └── post.ts         # Post-review handler
├── app/                    # Probot GitHub App (consumes lib)
│   └── src/
│       ├── index.ts        # App entry point & event handlers
│       └── handlers/       # Webhook route handlers
├── prompts/                # Custom prompt templates
├── docker/                 # Docker Compose for local dev
├── docs/                   # Additional documentation
├── examples/               # Example workflows
├── .agents/                # Customizations folder for AI agents
│   └── AGENTS.md           # Coding rules and commands for development agents
├── .opencode-reviewer.yml  # Dogfooding configuration file for reviews
├── .env.example            # Environment variables template
├── LICENSE                 # MIT License details
└── pnpm-workspace.yaml     # Workspace config (lib, action, app)
```

---

## Workspace Customization Rules (`AGENTS.md`)

If you are developing this codebase using an AI assistant (like Gemini or Antigravity), a dedicated workspace rule file is available under [`.agents/AGENTS.md`](.agents/AGENTS.md). This file guides the agent on monorepo package relationships, build instructions, linting commands, and verification processes.

---

## Contributing

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code conventions, and the PR process.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history and version notes.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

