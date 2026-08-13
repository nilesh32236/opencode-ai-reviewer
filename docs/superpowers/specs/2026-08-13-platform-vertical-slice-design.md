# OpenCode Platform — Vertical Slice Design (Phase 0 + Minimal Dashboard)

> **Created:** 2026-08-13
> **Status:** Approved
> **Source plan:** `PLATFORM-PLAN.md` (with verified corrections below)
> **Scope:** Build the first vertical slice end-to-end: GitHub webhook → BullMQ task queue → worker running `lib/` ReviewEngine → Postgres-backed task status → bundled dashboard. Prove the architecture before building the remaining phases.

---

## Verified corrections to PLATFORM-PLAN.md

Research against the live OpenCode CLI **v1.18.18** (installed at `~/.opencode/bin/opencode`) and current docs found these plan errors:

| Plan says | Reality (v1.18.18) |
|---|---|
| `@opencode-ai/client` package | Does not exist (reserved stub, v0.0.0). Real SDK is **`@opencode-ai/sdk`** (v1.18.18). |
| `POST /api/session` | `POST /session` (no `/api` prefix) |
| `POST /api/session/{id}/prompt` | `POST /session/:id/message` (sync) / `POST /session/:id/prompt_async` (async) |
| `POST /api/session/{id}/interrupt` | `POST /session/:id/abort` |
| `--port` default 4096 | Default `0` (random port) — must pass `--port` explicitly |
| SDK usage | `client.session.create()`, `.chat(id, {providerID, modelID, parts})`, `.abort(id)` |
| Events | `GET /event` (SSE) + `GET /global/event`; health `GET /global/health` → `{healthy, version}` |

Verified live: `opencode serve --port N` starts a headless HTTP server; `POST /session` creates a session bound to the working directory. `opencode web` serves the embeddable web UI. Basic auth via `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`.

## Design decisions (user-approved)

- **Vertical slice:** Phase 0 foundation + minimal dashboard, not the whole plan.
- **Queue:** BullMQ + Redis.
- **Frontend:** bundled into the platform server (Vite + React, served by Express static middleware). No S3/CloudFront.
- **Deploy:** same EC2 instance, platform on port 8080 behind Caddy; existing Probot app untouched on 3000.
- **Review loop per chunk:** push PR → comment `/review` → the **existing deployed Probot app** (not the platform itself, which doesn't run until later chunks) reviews it → fix findings → merge. This validates the live webhook→app→review pipeline throughout development.

## Architecture

```text
GitHub Webhook ─▶ platform server (Express) ─▶ BullMQ Queue (Redis)
                                                  │
                                                  ▼
                                       Worker: clone → ReviewEngine.reviewPR → post to GitHub
                                                  │
                                                  ▼
                                       Postgres: tasks / repos / conversations / task_events
                                                  │
                                       Dashboard (Vite+React, SSE real-time)
```

## Package layout (`platform/`)

```text
platform/
├── package.json          # name @opencode-pr-agent/platform
├── tsconfig.json
├── src/
│   ├── index.ts          # boot: DB init → start queue/worker → start server
│   ├── server.ts         # Express app (health, api, webhook, static web)
│   ├── config.ts         # platform config from env (reuses lib config patterns)
│   ├── db/
│   │   ├── client.ts     # pg Pool + migration runner
│   │   └── schema.sql    # users, repositories, tasks, conversations, task_events
│   ├── queue/
│   │   ├── manager.ts    # BullMQ Queue wrapper (typed task data)
│   │   ├── worker.ts     # BullMQ Worker → runs lib ReviewEngine
│   │   └── types.ts      # Task types + job data interfaces
│   ├── workspace/
│   │   ├── manager.ts    # create/cleanup workspace dirs
│   │   └── git.ts        # execGit wrapper (reuses lib patterns)
│   ├── webhooks.ts       # GitHub webhook receiver + HMAC validation
│   └── routes/
│       ├── api.ts        # REST API + SSE events
│       └── proxy.ts      # per-workspace opencode serve proxy (stub in slice)
└── web/                  # Vite + React dashboard (bundled)
```

## Reuse from `lib/`

- `ReviewEngine` (`lib/src/engine.ts`) — constructed exactly as `app/src/subscribers/review.ts` does: `new ReviewEngine(config, adapter, learningStore, eventBus, repo, correlationId)`.
- `GitHubHelper` (`lib/src/utils/github.ts`) — platform adapter for GitHub API.
- `loadConfig` / `mergeConfigWithInputs` (`lib/src/config.ts`).
- `EventBus` / `EventRouter` (`lib/src/event-bus/`).
- `runOpenCode` / `opencode.ts` — worker uses same CLI binary path resolution.
- Logger from `lib/src/utils/logger.ts`.

## Database (PostgreSQL via `pg` pool, raw SQL — matches repo's hand-rolled SQL style)

Tables from PLATFORM-PLAN §4.3: `users`, `repositories`, `tasks` (type/status enums, PR context, workspace path, result_data JSONB), `conversations`, `task_events`. Indexes on `tasks(status)`, `tasks(repo_id)`, `tasks(repo_id, pr_number)`, `task_events(task_id)`. Numbered migration files applied at boot.

## Security & idempotency notes (design decisions for chunks 5-7)

- **Authentication/authorization is deferred to Phase 4** (GitHub OAuth + RBAC). Until then, the platform's REST API, SSE stream, dashboard, and workspace proxy are **not exposed publicly** — they sit behind the Caddy reverse proxy bound to the same host, with webhook delivery the only public surface (HMAC-verified). Chunk 7 adds an opt-in `PLATFORM_API_TOKEN` bearer check so the API is never silently open.
- **Idempotency:** GitHub deliveries carry a unique `X-GitHub-Delivery` header. Chunk 5 persists this delivery ID with a unique constraint in a `webhook_events` table (dedupes GitHub redelivery), and derives a deterministic BullMQ `jobId` from `(repo, pr_number, head_sha, task_type)` so a re-enqueued review for the same commit replaces rather than duplicates. Comment posting (Chunk 6) persists a `comments_posted` row with a unique `(repo, pr, kind)` key before retrying publication, so a retried job never double-posts.

## Chunk plan (each chunk = one PR + /review + fix cycle)

| # | PR contents |
|---|---|
| 1 | `platform/` scaffold: package.json, tsconfig, pnpm-workspace + root tsconfig + CI wiring, minimal `index.ts`/`server.ts` with `/health`. |
| 2 | DB layer: `schema.sql`, `client.ts` (pool + migrations). |
| 3 | Compose + config: `docker/docker-compose.platform.yml` (postgres/redis/platform), `config.ts`, `.env.platform.example`. |
| 4 | Queue + workspace: BullMQ manager/worker/types, workspace manager + git wrapper. |
| 5 | Webhook receiver + task enqueue (HMAC validation). |
| 6 | Worker → ReviewEngine integration (clone → review → post → persist). |
| 7 | REST API + SSE events. |
| 8 | Dashboard: Vite + React bundled, served by Express. |
| 9 | Deploy workflow (rsync + compose up, port 8080, Caddy) + end-to-end test. |

## Testing & verification per chunk

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (biome + tsc + vitest).
- Chunk 1–2: unit tests for config/db (vitest).
- Chunk 6+: integration smoke — enqueue a review task against a test repo and assert completion.
- Each PR: `/review` via the live app; findings fixed before merge.
