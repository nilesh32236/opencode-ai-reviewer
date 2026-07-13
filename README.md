# OpenCode AI Reviewer

AI-powered PR review, auto-fix, and codebase audit — as a GitHub Action and a GitHub App (Probot).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![PNPM](https://img.shields.io/badge/Package%20Manager-pnpm-orange.svg)](https://pnpm.io/)
[![Architecture Guide](https://img.shields.io/badge/Architecture-Agentic-purple.svg)](agent.md)

- **Review** PRs for bugs, security issues, and style problems.
- **Auto-fix** issues iteratively using compiler and test errors.
- **Audit** an entire codebase and file GitHub issues for findings.

Uses OpenCode models (`opencode/deepseek-v4-flash-free`) by default; also supports OpenAI, Anthropic, and Gemini.

For details on the agent's internal architecture, execution loops, and prompt designs, refer to the [Architecture & Design Guide](agent.md).

---

## Quick Start — GitHub Action

Create `.github/workflows/pr-review.yml`:

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
| `run_checks_after_fix`   | —                                    | Commands to run after fix (e.g. `npm run lint`) |
| `audit_prompt_file`      | —                                    | Path to custom audit prompt file               |
| `audit_create_issues`    | `true`                               | Create GitHub issues for audit findings        |
| `audit_auto_fix`         | `false`                              | Auto-trigger fixes for audit findings          |
| `audit_labels`           | `audit`                              | Comma-separated labels for audit issues        |

**Outputs:** `review_summary`, `verdict`, `critical_count`, `important_count`, `minor_count`, `changes_made`.

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

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

