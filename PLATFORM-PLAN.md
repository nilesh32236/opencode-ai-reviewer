# OpenCode AI Reviewer — Web Platform Plan

> **Created:** 2026-08-13
> **Status:** DRAFT — awaiting review and refinement
> **Goal:** Build a self-hosted, asynchronous web platform ("OpenCode Platform") that runs on AWS, provides a Jules-like experience for AI-powered code reviews, and integrates the existing review engine with OpenCode's web UI for interactive conversations.

---

## Table of Contents

1. [Vision & Architecture Overview](#1-vision--architecture-overview)
2. [Research Findings — OpenCode Web](#2-research-findings--opencode-web)
3. [Architecture Decision Records](#3-architecture-decision-records)
4. [Phase 0 — Foundation & Infrastructure](#4-phase-0--foundation--infrastructure)
5. [Phase 1 — Task Queue & Worker Engine](#5-phase-1--task-queue--worker-engine)
6. [Phase 2 — Web Dashboard & API](#6-phase-2--web-dashboard--api)
7. [Phase 3 — OpenCode Web Integration](#7-phase-3--opencode-web-integration)
8. [Phase 4 — Authentication & Multi-User](#8-phase-4--authentication--multi-user)
9. [Phase 5 — Lifecycle Management & Cleanup](#9-phase-5--lifecycle-management--cleanup)
10. [Phase 6 — Scaling & Production Hardening](#10-phase-6--scaling--production-hardening)
11. [Deployment Tiers](#11-deployment-tiers)
12. [Migration Path from Probot App](#12-migration-path-from-probot-app)
13. [Open Questions](#13-open-questions)

---

## 1. Vision & Architecture Overview

### What We're Building

A **self-hosted platform** that:

1. **Receives GitHub webhooks** (PR opened, synchronized, merged, comments) — replacing/extending the current Probot App
2. **Queues and executes review tasks asynchronously** in isolated workspace directories on the server
3. **Provides a web dashboard** showing all active/completed tasks (reviews, fixes, audits) with real-time status
4. **Embeds OpenCode Web UI** for interactive AI conversations — users can chat with the AI agent about code, start new conversations, and open PRs directly from the browser
5. **Manages workspace lifecycle** — clones repos on demand, cleans up when PRs merge, archives conversation data to S3
6. **Supports multi-repo and multi-user** with GitHub OAuth and role-based access

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        USERS (Web Browser)                             │
│   ┌──────────────────────┐    ┌──────────────────────────────────┐     │
│   │   Platform Dashboard │    │  OpenCode Web UI (embedded)      │     │
│   │   - Task list/status │    │  - Interactive AI conversations  │     │
│   │   - Start new tasks  │    │  - File editing, terminal        │     │
│   │   - Repo management  │    │  - Open PRs from browser         │     │
│   └──────────┬───────────┘    └──────────────┬───────────────────┘     │
└──────────────┼───────────────────────────────┼────────────────────────-┘
               │ REST API                      │ Proxied WebSocket/HTTP
┌──────────────▼───────────────────────────────▼────────────────────────-┐
│                     PLATFORM SERVER (Node.js)                          │
│                                                                        │
│  ┌─────────────┐  ┌───────────────┐  ┌─────────────────────────────┐  │
│  │ Webhook     │  │ REST API      │  │ OpenCode Process Manager    │  │
│  │ Receiver    │  │ (Dashboard)   │  │ (spawn/manage `opencode     │  │
│  │ (GitHub)    │  │               │  │  serve` per workspace)      │  │
│  └──────┬──────┘  └───────┬───────┘  └──────────────┬──────────────┘  │
│         │                 │                          │                  │
│  ┌──────▼─────────────────▼──────────────────────────▼──────────────┐  │
│  │                    TASK QUEUE & SCHEDULER                        │  │
│  │  - BullMQ (Redis-backed) or in-process queue                    │  │
│  │  - Priority scheduling, concurrency limits                      │  │
│  │  - Retry with backoff on failure                                │  │
│  └──────────────────────────┬───────────────────────────────────────┘  │
│                             │                                          │
│  ┌──────────────────────────▼───────────────────────────────────────┐  │
│  │                    WORKER ENGINE                                 │  │
│  │  - Isolated workspace directories per repo/PR                   │  │
│  │  - Uses existing lib/ ReviewEngine                              │  │
│  │  - Manages git clone/fetch/checkout per task                    │  │
│  │  - Spawns `opencode serve` for interactive sessions             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    DATA LAYER                                    │  │
│  │  PostgreSQL: tasks, users, repos, sessions, audit log           │  │
│  │  Redis: task queue, real-time events (SSE/WebSocket)             │  │
│  │  S3: archived conversations, workspace snapshots                │  │
│  │  Filesystem: active workspaces (/data/workspaces/<repo>/<pr>)   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│          EXTERNAL SERVICES           │
│  GitHub API (webhooks, PRs, repos)   │
│  LLM Providers (OpenAI, Anthropic…)  │
│  OpenCode CLI (binary, per-worker)   │
└──────────────────────────────────────┘
```

---

## 2. Research Findings — OpenCode Web

### Key Discoveries

| Capability | Details |
|---|---|
| **`opencode serve`** | Starts a headless HTTP server exposing an OpenAPI 3.1 REST API. Supports `--hostname`, `--port`, `--cors` flags. |
| **`opencode web`** | Spawns a local server and opens the browser-based web UI. The web UI communicates with the server over HTTP/WebSocket. |
| **Session API** | Full CRUD: `POST /api/session` (create), `GET /api/session` (list), `DELETE /api/session/{id}` (delete). |
| **Session Execution** | `POST /api/session/{id}/prompt` (send message), `POST /api/session/{id}/command` (slash command), `POST /api/session/{id}/interrupt` (stop). |
| **Authentication** | `OPENCODE_SERVER_PASSWORD` env var enables HTTP Basic Auth on the server. |
| **Client SDK** | `@opencode-ai/client` npm package for programmatic access to the API. |
| **Multi-Session** | Multiple sessions can run concurrently on the same codebase without context leakage. |
| **Configuration** | `OPENCODE_CONFIG_CONTENT` env var injects config (model, permissions, tools) without writing files. |

### How We Use This

1. **Per-workspace `opencode serve`**: For each active workspace (repo checkout), we spawn an `opencode serve` process bound to a unique port. The platform server reverse-proxies requests from the web dashboard to the correct `opencode serve` instance.

2. **Embedded Web UI**: The OpenCode web UI connects to the `opencode serve` backend. We embed it in an iframe or proxy its assets through our platform server under a path like `/workspace/{id}/opencode/`.

3. **Programmatic Control**: The platform's worker engine uses `@opencode-ai/client` SDK (or direct HTTP calls) to create sessions, send prompts, and monitor execution — enabling automated review tasks that are also accessible interactively via the web.

4. **Current Codebase Integration**: The existing `lib/src/opencode.ts` already downloads, validates, and invokes the `opencode` CLI binary. We extend this to also manage `opencode serve` processes.

---

## 3. Architecture Decision Records

### ADR-1: New `platform/` Package (Recommended)

**Decision**: Create a new `platform/` package in the monorepo rather than extending `app/`.

**Rationale**:
- The existing `app/` package is tightly coupled to Probot's event model and Express middleware
- The platform needs fundamentally different concerns: task queue, workspace management, multi-user auth, process management
- A new package can import from `lib/` (same dependency flow) without breaking the existing `app/` or `action/`
- The Probot App continues to run alongside during migration; webhook processing is eventually absorbed into `platform/`

**Monorepo after this change**:
```
packages:
  - lib          # Shared core (unchanged)
  - action       # GitHub Action (unchanged)
  - app          # Probot App (maintained, eventually deprecated)
  - cli          # Local CLI (unchanged)
  - platform     # NEW: Web platform server
```

### ADR-2: Hybrid Session Management (Recommended)

**Decision**: Use our own PostgreSQL database for task/job orchestration + OpenCode's built-in session management for AI conversations.

**Rationale**:
- **Our DB** tracks: which PRs are being reviewed, task status, user assignments, repo configs, audit logs, cleanup schedules
- **OpenCode sessions** handle: conversation history, AI context, tool execution state
- This avoids reimplementing conversation management while giving us full control over the orchestration layer
- The existing `LearningStore` patterns (findings, feedback, suppression rules) remain in PostgreSQL

### ADR-3: EC2 + Docker Compose for Start, ECS for Scale (Recommended)

**Decision**: Start with a single EC2 instance running Docker Compose; provide ECS migration path for scaling.

**Rationale**:
- Simplest starting point: familiar Docker Compose setup (extends existing `docker/`)
- Single instance handles moderate load (5-10 concurrent reviews)
- Clear upgrade path: containerize each component, move to ECS/Fargate when needed
- Avoids premature infrastructure complexity

### ADR-4: Access & Security (Recommended)

**Decision**: GitHub webhooks are publicly accessible (required); web UI is behind GitHub OAuth + HTTPS.

**Rationale**:
- GitHub must be able to reach webhook endpoints → public with webhook secret validation
- Web UI access via GitHub OAuth → users authenticate with their GitHub identity
- HTTPS via AWS ALB or Caddy reverse proxy with Let's Encrypt
- API keys for programmatic access (CI/CD integration)

---

## 4. Phase 0 — Foundation & Infrastructure

> **Goal**: Set up the AWS infrastructure, new `platform/` package skeleton, and database schema.
> **Estimated Effort**: 1-2 weeks

### 4.1 AWS Infrastructure

```
┌─────────────────────────────────────────────────────┐
│                   AWS VPC                            │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  EC2 Instance (t3.xlarge or c6i.xlarge)      │   │
│  │  - Docker Compose                            │   │
│  │  - Platform Server container                 │   │
│  │  - PostgreSQL container (or RDS)             │   │
│  │  - Redis container (or ElastiCache)          │   │
│  │  - Caddy reverse proxy (HTTPS)               │   │
│  │  - Persistent EBS volume (/data)             │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  S3 Bucket: opencode-platform-archives       │   │
│  │  - Archived conversations                    │   │
│  │  - Workspace snapshots                       │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  Security Group:                                     │
│  - Inbound 443 (HTTPS) from anywhere                │
│  - Inbound 22 (SSH) from admin IPs                  │
│  - Outbound all (GitHub API, LLM providers)         │
└─────────────────────────────────────────────────────┘
```

**Instance sizing recommendation**:
| Tier | Instance | vCPU | RAM | Storage | Concurrent Reviews |
|------|----------|------|-----|---------|-------------------|
| Starter | t3.large | 2 | 8 GB | 100 GB EBS | 2-3 |
| Standard | t3.xlarge | 4 | 16 GB | 200 GB EBS | 5-8 |
| Production | c6i.2xlarge | 8 | 16 GB | 500 GB EBS | 10-15 |

### 4.2 New `platform/` Package Setup

```
platform/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # Server entry point
│   ├── server.ts                # Express/Fastify HTTP server
│   ├── config.ts                # Platform-specific config
│   ├── routes/
│   │   ├── webhooks.ts          # GitHub webhook receiver
│   │   ├── api.ts               # REST API for dashboard
│   │   ├── auth.ts              # OAuth & session routes
│   │   └── proxy.ts             # OpenCode Web UI proxy
│   ├── queue/
│   │   ├── manager.ts           # Task queue manager
│   │   ├── worker.ts            # Task worker (review, fix, audit)
│   │   └── types.ts             # Task type definitions
│   ├── workspace/
│   │   ├── manager.ts           # Workspace lifecycle (create, cleanup)
│   │   ├── git.ts               # Git clone/fetch/checkout
│   │   └── opencode-process.ts  # OpenCode serve process manager
│   ├── db/
│   │   ├── schema.ts            # Database schema (Drizzle ORM or raw SQL)
│   │   ├── migrations/          # Database migrations
│   │   └── client.ts            # PostgreSQL connection
│   ├── auth/
│   │   ├── github-oauth.ts      # GitHub OAuth flow
│   │   ├── session.ts           # JWT session management
│   │   └── rbac.ts              # Role-based access control
│   └── utils/
│       ├── s3.ts                # S3 archive operations
│       └── events.ts            # SSE/WebSocket event streaming
├── web/                         # Frontend (Next.js or Vite + React)
│   ├── package.json
│   ├── src/
│   │   ├── pages/
│   │   │   ├── dashboard.tsx    # Main task dashboard
│   │   │   ├── workspace.tsx    # Single workspace/conversation view
│   │   │   ├── repos.tsx        # Repository management
│   │   │   └── settings.tsx     # User/platform settings
│   │   ├── components/
│   │   │   ├── TaskList.tsx
│   │   │   ├── TaskDetail.tsx
│   │   │   ├── OpenCodeEmbed.tsx  # Embedded OpenCode Web UI
│   │   │   └── StatusBadge.tsx
│   │   └── hooks/
│   │       ├── useSSE.ts        # Server-Sent Events for live updates
│   │       └── useApi.ts        # API client hooks
│   └── ...
└── tests/
```

### 4.3 Database Schema (PostgreSQL)

```sql
-- Core tables for the platform

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     BIGINT UNIQUE NOT NULL,
  github_login  TEXT NOT NULL,
  avatar_url    TEXT,
  role          TEXT NOT NULL DEFAULT 'reviewer', -- admin, reviewer, viewer
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE repositories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     BIGINT UNIQUE NOT NULL,
  owner         TEXT NOT NULL,
  name          TEXT NOT NULL,
  full_name     TEXT NOT NULL, -- owner/name
  webhook_id    BIGINT,        -- GitHub webhook ID (for management)
  config        JSONB DEFAULT '{}', -- repo-specific review config overrides
  enabled       BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TYPE task_type AS ENUM ('review', 'fix', 'audit', 'analyze', 'docs', 'conversation');
CREATE TYPE task_status AS ENUM (
  'queued', 'cloning', 'running', 'waiting_input',
  'completed', 'failed', 'cancelled', 'archiving', 'archived'
);

CREATE TABLE tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id           UUID REFERENCES repositories(id),
  type              task_type NOT NULL,
  status            task_status NOT NULL DEFAULT 'queued',
  priority          INT DEFAULT 0,
  -- PR context (nullable for non-PR tasks)
  pr_number         INT,
  pr_title          TEXT,
  head_sha          TEXT,
  base_branch       TEXT,
  head_branch       TEXT,
  -- Workspace
  workspace_path    TEXT,          -- /data/workspaces/<repo>/<pr-or-task-id>
  opencode_port     INT,           -- Port assigned to `opencode serve` for this workspace
  opencode_pid      INT,           -- PID of the opencode serve process
  -- Execution
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  result_summary    TEXT,          -- Short result summary
  result_data       JSONB,         -- Full result (findings, verdict, etc.)
  error_message     TEXT,
  -- Metadata
  triggered_by      UUID REFERENCES users(id),
  trigger_source    TEXT DEFAULT 'webhook', -- webhook, manual, schedule
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE conversations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID REFERENCES tasks(id),
  opencode_session  TEXT,          -- OpenCode session ID
  title             TEXT,
  status            TEXT DEFAULT 'active', -- active, archived, deleted
  archived_s3_key   TEXT,          -- S3 key for archived conversation data
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE task_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID REFERENCES tasks(id),
  event_type    TEXT NOT NULL,  -- status_change, log, error, finding
  payload       JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_repo ON tasks(repo_id);
CREATE INDEX idx_tasks_pr ON tasks(repo_id, pr_number);
CREATE INDEX idx_events_task ON task_events(task_id);
```

### 4.4 Phase 0 Deliverables

- [ ] AWS infrastructure provisioned (EC2, security groups, EBS, S3 bucket)
- [ ] `platform/` package scaffolded in monorepo
- [ ] PostgreSQL schema created with migrations
- [ ] Docker Compose extended with PostgreSQL, Redis, platform server
- [ ] Basic health endpoint (`GET /health`) running
- [ ] CI pipeline updated to build/test the new package

---

## 5. Phase 1 — Task Queue & Worker Engine

> **Goal**: Build the async task processing system that clones repos, runs reviews, and manages workspaces.
> **Estimated Effort**: 2-3 weeks
> **Dependencies**: Phase 0

### 5.1 Task Queue Architecture

```
GitHub Webhook ──▶ Webhook Handler ──▶ Task Queue (BullMQ/Redis)
                                              │
                                       ┌──────▼──────┐
                                       │   Worker     │
                                       │  Pool (N)    │
                                       └──────┬──────┘
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼                     ▼                     ▼
                 Clone/Fetch Repo      Run ReviewEngine       Post Results
                 (workspace mgr)       (from lib/)           (GitHub API)
```

**Queue options (choose one)**:

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **BullMQ + Redis** | Battle-tested, priorities, retries, rate limiting, dashboard (Bull Board) | Requires Redis | ✅ Recommended for production |
| **In-process queue** (custom) | No Redis dependency, simpler | No persistence on crash, no dashboard | Good for starter tier |
| **pg-boss** (PostgreSQL) | Uses existing PostgreSQL, no Redis | Slower polling, less ecosystem | Viable alternative |

### 5.2 Workspace Manager

Each task gets an isolated workspace directory:

```
/data/workspaces/
├── nilesh32236/
│   └── opencode-ai-reviewer/
│       ├── _base/                    # Bare clone (shared, updated periodically)
│       ├── pr-123/                   # Worktree for PR #123
│       │   ├── .git/                 # Git worktree link
│       │   ├── src/                  # Checked-out code
│       │   └── .opencode/            # OpenCode session data
│       ├── pr-456/                   # Another active PR
│       └── conv-abc123/              # Manual conversation workspace
```

**Key operations**:

```typescript
interface WorkspaceManager {
  /** Create workspace for a PR review task */
  createPRWorkspace(repo: Repository, pr: PRInfo): Promise<Workspace>;

  /** Create workspace for a manual conversation */
  createConversationWorkspace(repo: Repository, branch?: string): Promise<Workspace>;

  /** Clean up workspace files (keeps conversation data) */
  cleanupWorkspace(workspace: Workspace): Promise<void>;

  /** Archive workspace conversations to S3 before deletion */
  archiveAndCleanup(workspace: Workspace): Promise<string>; // returns S3 key

  /** List active workspaces with disk usage */
  listWorkspaces(): Promise<WorkspaceInfo[]>;
}
```

**Workspace lifecycle**:
```
                    PR Opened / Manual Start
                            │
                            ▼
                    ┌───────────────┐
                    │   CREATING    │  git clone/worktree
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │    ACTIVE     │  review running / conversation open
                    └───────┬───────┘
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
      PR Merged      Task Complete     Manual Close
              │             │              │
              ▼             ▼              ▼
        ┌─────────────────────────────────────┐
        │          ARCHIVING                   │
        │  - Export conversations to S3        │
        │  - Record final results in DB        │
        └──────────────┬──────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │    CLEANED     │  workspace files deleted
              └────────────────┘
```

### 5.3 Worker Engine

The worker reuses the existing `lib/` `ReviewEngine`:

```typescript
// Simplified worker flow
async function processReviewTask(task: Task): Promise<void> {
  // 1. Create/update workspace
  const workspace = await workspaceManager.createPRWorkspace(task.repo, task.pr);

  // 2. Configure the review engine
  const engine = new ReviewEngine({
    workingDir: workspace.path,
    config: mergeConfigs(task.repo.config, defaultConfig),
    learningStore: platformLearningStore,
    eventBus: platformEventBus,
  });

  // 3. Build PR context
  const prContext = await buildPRContext(task, workspace);

  // 4. Run review
  const result = await engine.reviewPR(prContext);

  // 5. Post results to GitHub
  await postReviewToGitHub(task, result);

  // 6. Store results in DB
  await db.updateTask(task.id, {
    status: 'completed',
    result_data: result,
    result_summary: result.verdict,
  });

  // 7. Emit real-time event for dashboard
  eventStream.emit('task:completed', { taskId: task.id, result });
}
```

### 5.4 GitHub Webhook Handler

```typescript
// Webhook events we handle
const WEBHOOK_EVENTS = {
  'pull_request.opened': 'enqueueReview',
  'pull_request.synchronize': 'enqueueReview',
  'pull_request.closed': 'handlePRClosed',     // cleanup if merged
  'pull_request.reopened': 'enqueueReview',
  'issue_comment.created': 'handleComment',     // /review, /fix, /audit commands
  'pull_request_review.submitted': 'handleReviewFeedback',
};
```

### 5.5 Phase 1 Deliverables

- [ ] Task queue with BullMQ (or in-process for starter tier)
- [ ] Workspace manager: clone, worktree, cleanup, disk usage tracking
- [ ] Worker engine that runs reviews using `lib/` `ReviewEngine`
- [ ] GitHub webhook receiver with secret validation
- [ ] Task status tracking in PostgreSQL
- [ ] Real-time task events via SSE
- [ ] Basic error handling and retry logic

---

## 6. Phase 2 — Web Dashboard & API

> **Goal**: Build the web frontend and REST API that shows all tasks, their status, and allows starting new tasks.
> **Estimated Effort**: 2-3 weeks
> **Dependencies**: Phase 1

### 6.1 REST API Endpoints

```
# Task Management
GET    /api/tasks                    # List tasks (filterable by repo, status, type)
GET    /api/tasks/:id                # Get task details
POST   /api/tasks                    # Create new task (manual review/conversation)
DELETE /api/tasks/:id                # Cancel/delete task
POST   /api/tasks/:id/retry          # Retry a failed task

# Task Events (real-time)
GET    /api/tasks/:id/events         # SSE stream for task events
GET    /api/events                   # SSE stream for all events (dashboard)

# Repository Management
GET    /api/repos                    # List configured repositories
POST   /api/repos                    # Add repository
PUT    /api/repos/:id                # Update repo config
DELETE /api/repos/:id                # Remove repository
POST   /api/repos/:id/webhook        # Register/update GitHub webhook

# Workspace Management
GET    /api/workspaces               # List active workspaces with disk usage
GET    /api/workspaces/:id           # Workspace details
DELETE /api/workspaces/:id           # Force cleanup workspace

# Conversations
GET    /api/conversations            # List conversations
GET    /api/conversations/:id        # Conversation details
POST   /api/conversations            # Start new conversation
DELETE /api/conversations/:id        # Archive and delete

# System
GET    /api/health                   # Health check
GET    /api/metrics                  # System metrics (disk, memory, queue depth)
```

### 6.2 Dashboard Pages

#### Main Dashboard (`/`)
```
┌─────────────────────────────────────────────────────────────────┐
│  OpenCode Platform                          [+ New Task]  👤    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  System Status: ● Healthy   Queue: 3 pending   Disk: 45% used  │
│                                                                  │
│  ┌─── Active Tasks ─────────────────────────────────────────┐   │
│  │                                                           │   │
│  │  ● Running  PR #123  opencode-ai-reviewer  Review         │   │
│  │    "Fix retry logic in circuit breaker"  ⏱ 2m 15s         │   │
│  │                                                           │   │
│  │  ● Running  PR #89   my-app               Fix             │   │
│  │    "Add input validation"  ⏱ 5m 30s                       │   │
│  │                                                           │   │
│  │  ○ Queued   PR #456  api-service          Review          │   │
│  │    "Refactor auth middleware"                              │   │
│  │                                                           │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─── Recent Completed ─────────────────────────────────────┐   │
│  │                                                           │   │
│  │  ✓ Done   PR #122  opencode-ai-reviewer  Review  3 issues│   │
│  │  ✓ Done   PR #88   my-app               Fix    All clear │   │
│  │  ✗ Failed PR #455  api-service          Audit   Timeout  │   │
│  │                                                           │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Task Detail View (`/tasks/:id`)
```
┌─────────────────────────────────────────────────────────────────┐
│  ← Back   PR #123 Review — opencode-ai-reviewer                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Status: ● Running   Duration: 2m 15s   Model: gpt-4o          │
│  Branch: fix/retry-logic → main                                 │
│  Triggered by: @nilesh32236 (webhook)                           │
│                                                                  │
│  ┌─── Findings ─────────────────────────────────────────────┐   │
│  │  🔴 CRITICAL  src/utils/retry.ts:45                       │   │
│  │     Missing timeout on recursive retry call               │   │
│  │                                                           │   │
│  │  🟡 IMPORTANT src/utils/circuit-breaker.ts:120            │   │
│  │     Race condition in half-open state                     │   │
│  │                                                           │   │
│  │  🔵 MINOR     src/index.ts:15                             │   │
│  │     Unused import                                         │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  [Open Conversation]  [View on GitHub]  [Retry]                 │
│                                                                  │
│  ┌─── Event Log ────────────────────────────────────────────┐   │
│  │  16:01:23  Task queued                                    │   │
│  │  16:01:25  Workspace created                              │   │
│  │  16:01:30  Git clone completed                            │   │
│  │  16:01:32  Review started (multi-agent mode)              │   │
│  │  16:02:45  Security agent completed (1 finding)           │   │
│  │  16:03:15  Quality agent completed (2 findings)           │   │
│  │  16:03:38  Synthesis in progress...                       │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Frontend Technology

**Recommended**: Vite + React + TypeScript

- Fast build, HMR for development
- React for component composition
- Server-Sent Events (SSE) for real-time updates
- No heavy framework overhead

### 6.4 Phase 2 Deliverables

- [ ] REST API endpoints (all CRUD operations)
- [ ] SSE event streaming for real-time updates
- [ ] Dashboard: task list, task detail, system status
- [ ] Repository management page
- [ ] "New Task" modal (select repo, type, branch/PR)
- [ ] Error states and loading skeletons
- [ ] Responsive layout (desktop + tablet)

---

## 7. Phase 3 — OpenCode Web Integration

> **Goal**: Embed OpenCode's web UI for interactive AI conversations within the platform.
> **Estimated Effort**: 2-3 weeks
> **Dependencies**: Phase 1, Phase 2

### 7.1 OpenCode Process Manager

For each active workspace that needs interactive access, we spawn a dedicated `opencode serve` process:

```typescript
interface OpenCodeProcessManager {
  /**
   * Start an `opencode serve` process for a workspace.
   * Assigns a unique port, sets up config, and returns connection info.
   */
  start(workspace: Workspace, options?: {
    model?: string;
    password?: string;
    config?: object;
  }): Promise<OpenCodeInstance>;

  /** Stop an opencode serve process */
  stop(workspaceId: string): Promise<void>;

  /** Get connection info for a running instance */
  getInstance(workspaceId: string): OpenCodeInstance | null;

  /** List all running instances with resource usage */
  listInstances(): Promise<OpenCodeInstance[]>;

  /** Graceful shutdown of all instances */
  shutdownAll(): Promise<void>;
}

interface OpenCodeInstance {
  workspaceId: string;
  port: number;
  pid: number;
  password: string;   // Auto-generated per instance
  startedAt: Date;
  status: 'starting' | 'ready' | 'stopping' | 'stopped';
}
```

### 7.2 Reverse Proxy for OpenCode Web UI

The platform server acts as a reverse proxy, routing web UI requests to the correct `opencode serve` instance:

```
Browser request:
  GET /workspace/{taskId}/opencode/*
                    │
                    ▼
Platform Server (reverse proxy):
  1. Authenticate user (JWT/session cookie)
  2. Look up task → workspace → opencode instance
  3. Proxy request to localhost:{instance.port}/*
  4. Handle WebSocket upgrade for real-time communication
```

```typescript
// Express middleware for OpenCode proxy
app.use('/workspace/:taskId/opencode', async (req, res, next) => {
  const task = await db.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Ensure opencode serve is running for this workspace
  let instance = processManager.getInstance(task.workspace_path);
  if (!instance) {
    instance = await processManager.start(task.workspace);
  }

  // Proxy to the opencode serve instance
  proxy.web(req, res, {
    target: `http://127.0.0.1:${instance.port}`,
    ws: true, // WebSocket support
    headers: {
      Authorization: `Basic ${Buffer.from(`:${instance.password}`).toString('base64')}`,
    },
  });
});
```

### 7.3 Conversation Management

When a user opens the "Open Conversation" view:

1. **Lazy start**: `opencode serve` is started on demand (not for every task)
2. **Session creation**: A new OpenCode session is created via the API
3. **Context injection**: The PR diff, review findings, and conversation history are injected as initial context
4. **Web UI loads**: The OpenCode web interface connects to the proxied backend
5. **User interacts**: The user can chat, edit code, run commands, and create PRs
6. **Session saved**: Session state persists in OpenCode's local storage within the workspace

### 7.4 Starting New Conversations from Web

Users can start fresh conversations independent of PRs:

```
1. User clicks "+ New Conversation" on dashboard
2. Selects repository and branch (or uses default branch)
3. Platform creates a workspace (git clone/checkout)
4. Starts `opencode serve` for the workspace
5. Redirects to the embedded OpenCode web UI
6. User interacts with the AI agent
7. Agent can edit files, run tests, and open PRs via GitHub API
```

### 7.5 Port Management

```typescript
// Simple port allocator for opencode serve instances
class PortAllocator {
  private basePort = 10000;
  private maxPort = 11000;
  private allocated = new Set<number>();

  allocate(): number {
    for (let port = this.basePort; port <= this.maxPort; port++) {
      if (!this.allocated.has(port)) {
        this.allocated.add(port);
        return port;
      }
    }
    throw new Error('No available ports for opencode serve');
  }

  release(port: number): void {
    this.allocated.delete(port);
  }
}
```

### 7.6 Phase 3 Deliverables

- [ ] OpenCode process manager (start/stop/monitor `opencode serve`)
- [ ] Reverse proxy with WebSocket support
- [ ] Port allocation and management
- [ ] "Open Conversation" integration on task detail page
- [ ] "New Conversation" flow from dashboard
- [ ] Conversation list and history
- [ ] Process health monitoring and auto-restart

---

## 8. Phase 4 — Authentication & Multi-User

> **Goal**: Add GitHub OAuth, user management, and role-based access control.
> **Estimated Effort**: 1-2 weeks
> **Dependencies**: Phase 2

### 8.1 Authentication Flow

```
┌─────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────┐
│ Browser  │────▶│ Platform     │────▶│ GitHub OAuth  │────▶│ GitHub  │
│          │     │ /auth/login  │     │ Authorize URL │     │         │
└─────────┘     └──────────────┘     └──────────────┘     └────┬────┘
                                                                │
                                                          User approves
                                                                │
┌─────────┐     ┌──────────────┐     ┌──────────────┐     ┌────▼────┐
│ Browser  │◀───│ Platform     │◀───│ GitHub        │◀───│ GitHub  │
│ (JWT     │    │ /auth/       │    │ Callback      │    │ (code)  │
│  cookie) │    │  callback    │    │ (token)       │    │         │
└─────────┘     └──────────────┘     └──────────────┘     └─────────┘
```

### 8.2 Roles & Permissions

| Role | Can View | Can Start Tasks | Can Manage Repos | Can Admin |
|------|----------|----------------|-----------------|-----------|
| **Viewer** | All tasks | ✗ | ✗ | ✗ |
| **Reviewer** | All tasks | ✓ | ✗ | ✗ |
| **Admin** | All tasks | ✓ | ✓ | ✓ |

### 8.3 API Key Support

For programmatic access (CI/CD, scripts):

```
POST /api/auth/api-keys        # Create API key
DELETE /api/auth/api-keys/:id  # Revoke API key
GET  /api/auth/api-keys        # List user's API keys

# Usage:
curl -H "Authorization: Bearer sk_live_abc123..." https://review.mydomain.com/api/tasks
```

### 8.4 Phase 4 Deliverables

- [ ] GitHub OAuth flow (login/logout)
- [ ] JWT session management with secure cookies
- [ ] User management (create on first login, role assignment)
- [ ] Role-based middleware for API routes
- [ ] API key generation and authentication
- [ ] Settings page for user profile and API keys

---

## 9. Phase 5 — Lifecycle Management & Cleanup

> **Goal**: Automatically clean up workspaces when PRs merge, archive conversations to S3, and manage storage.
> **Estimated Effort**: 1-2 weeks
> **Dependencies**: Phase 1, Phase 3

### 9.1 PR Merge Cleanup Flow

```
GitHub Webhook: pull_request.closed (merged=true)
        │
        ▼
┌───────────────────┐
│ Find all tasks     │  Query: tasks WHERE repo_id=X AND pr_number=Y
│ for this PR        │        AND status NOT IN ('archived', 'cancelled')
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ For each task:     │
│ 1. Stop opencode  │  Kill opencode serve process if running
│    serve           │
│ 2. Export          │  Serialize conversation data, findings, logs
│    conversations   │
│ 3. Upload to S3    │  s3://archives/{repo}/{pr}/{task-id}/
│ 4. Delete          │  rm -rf /data/workspaces/{repo}/pr-{N}/
│    workspace files │
│ 5. Update DB       │  task.status = 'archived', conversations.archived_s3_key = ...
└───────────────────┘
```

### 9.2 S3 Archive Structure

```
s3://opencode-platform-archives/
├── nilesh32236/
│   └── opencode-ai-reviewer/
│       ├── pr-123/
│       │   ├── task-abc123/
│       │   │   ├── conversations.json     # All conversation sessions
│       │   │   ├── review-result.json     # Full review findings
│       │   │   ├── event-log.jsonl        # Task event history
│       │   │   └── metadata.json          # Task metadata, timestamps
│       │   └── task-def456/
│       │       └── ...
│       └── pr-456/
│           └── ...
```

### 9.3 Storage Management

```typescript
interface StorageManager {
  /** Get total disk usage for workspaces */
  getDiskUsage(): Promise<{ total: number; used: number; available: number }>;

  /** Get per-workspace disk usage */
  getWorkspaceUsage(): Promise<Map<string, number>>;

  /** Clean up workspaces older than retention period */
  cleanupStale(maxAge: Duration): Promise<CleanupResult>;

  /** Emergency cleanup: remove largest inactive workspaces */
  emergencyCleanup(targetFreeBytes: number): Promise<CleanupResult>;
}
```

**Automatic cleanup triggers**:
1. **PR merged** → immediate archive + delete
2. **Scheduled** → daily cron checks for stale workspaces (no activity > configurable days)
3. **Disk pressure** → when usage > 80%, archive and clean oldest inactive workspaces
4. **Manual** → admin can force cleanup from dashboard

### 9.4 Phase 5 Deliverables

- [ ] PR merge webhook handler triggers cleanup
- [ ] S3 archive upload with structured format
- [ ] Stale workspace detection and cleanup
- [ ] Disk usage monitoring and alerts
- [ ] Archive browser in dashboard (view archived conversation data)
- [ ] Emergency cleanup for disk pressure
- [ ] Configurable retention policies

---

## 10. Phase 6 — Scaling & Production Hardening

> **Goal**: Prepare for production: monitoring, logging, security hardening, and scaling path.
> **Estimated Effort**: 2-3 weeks
> **Dependencies**: All previous phases

### 10.1 Monitoring & Observability

```
Metrics (CloudWatch / Prometheus):
- Queue depth and processing latency
- Active workspace count and disk usage
- OpenCode serve process count and memory
- Review completion rate and error rate
- API response times

Logging (structured JSON → CloudWatch Logs):
- All task lifecycle events
- Webhook processing (with request ID)
- Error stack traces
- Audit log (who did what, when)

Alerting:
- Queue depth > threshold → alert
- Disk usage > 80% → warning, > 90% → critical
- Failed tasks > N in last hour → alert
- OpenCode process crashes → alert
```

### 10.2 Security Hardening

- [ ] Webhook signature validation (X-Hub-Signature-256)
- [ ] Rate limiting on API endpoints
- [ ] CORS configuration
- [ ] Helmet.js security headers
- [ ] Input sanitization on all user inputs
- [ ] Secret rotation for API keys and OAuth credentials
- [ ] Workspace isolation (prevent cross-workspace access)
- [ ] Process sandboxing (opencode serve runs with limited permissions)

### 10.3 Scaling Path: EC2 → ECS

```
Phase 1-5 (Single Instance):
┌────────────────────────────┐
│  EC2 Instance              │
│  ┌──────┐ ┌──────┐ ┌────┐ │
│  │Server│ │PG/RDS│ │Redis│ │
│  └──────┘ └──────┘ └────┘ │
└────────────────────────────┘

Phase 6+ (ECS Scaling):
┌─────────────────────────────────────────────────┐
│  ECS Cluster                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  │ Server  │  │ Worker  │  │ Worker  │  ← Auto  │
│  │ (API +  │  │ (tasks) │  │ (tasks) │   Scale  │
│  │  proxy) │  │         │  │         │          │
│  └─────────┘  └─────────┘  └─────────┘         │
│                                                  │
│  EFS (shared workspaces) or EBS per-worker       │
│  RDS PostgreSQL (managed)                        │
│  ElastiCache Redis (managed)                     │
│  ALB (load balancer, HTTPS termination)          │
└─────────────────────────────────────────────────┘
```

### 10.4 Phase 6 Deliverables

- [ ] Structured JSON logging
- [ ] CloudWatch metrics and dashboards
- [ ] Alerting rules (SNS/PagerDuty)
- [ ] Security hardening checklist completed
- [ ] ECS task definitions and service configs
- [ ] RDS PostgreSQL migration
- [ ] ElastiCache Redis setup
- [ ] ALB with HTTPS and auto-scaling policies
- [ ] CI/CD pipeline for deployment (GitHub Actions → ECR → ECS)

---

## 11. Deployment Tiers

### Tier 1: Starter ($20-50/month)

| Component | Service | Cost |
|-----------|---------|------|
| Server | EC2 t3.medium (2 vCPU, 4 GB) | ~$30/mo |
| Database | PostgreSQL in Docker on same instance | $0 |
| Queue | Redis in Docker on same instance | $0 |
| Storage | 50 GB EBS gp3 | ~$5/mo |
| Archives | S3 (pay per use) | ~$1/mo |
| SSL | Let's Encrypt via Caddy | $0 |

**Capacity**: 2-3 concurrent reviews, 1-2 interactive sessions

### Tier 2: Standard ($100-200/month)

| Component | Service | Cost |
|-----------|---------|------|
| Server | EC2 t3.xlarge (4 vCPU, 16 GB) | ~$120/mo |
| Database | RDS db.t3.micro PostgreSQL | ~$15/mo |
| Queue | ElastiCache t3.micro Redis | ~$15/mo |
| Storage | 200 GB EBS gp3 | ~$16/mo |
| Archives | S3 | ~$2/mo |
| SSL/Domain | ACM + Route 53 | ~$1/mo |

**Capacity**: 5-8 concurrent reviews, 3-5 interactive sessions

### Tier 3: Production ($300-600/month)

| Component | Service | Cost |
|-----------|---------|------|
| Server | ECS Fargate (auto-scaled) | ~$200-400/mo |
| Database | RDS db.t3.small PostgreSQL (Multi-AZ) | ~$50/mo |
| Queue | ElastiCache t3.small Redis | ~$30/mo |
| Storage | EFS | ~$30/mo |
| Archives | S3 + lifecycle rules | ~$5/mo |
| CDN | CloudFront (for web assets) | ~$10/mo |
| ALB | Application Load Balancer | ~$20/mo |

**Capacity**: 10-20 concurrent reviews, auto-scaled

> [!NOTE]
> These costs do **not** include LLM API costs (OpenAI, Anthropic, etc.), which depend on usage volume and model selection. Budget $50-500+/month for LLM costs depending on review volume.

---

## 12. Migration Path from Probot App

### Stage 1: Side-by-Side (Phases 0-3)

```
GitHub ──webhooks──▶ Probot App (existing, port 3000)
       └─webhooks──▶ Platform Server (new, port 8080)
```

- Both receive the same webhooks (configure two webhook URLs on GitHub)
- Probot handles production reviews
- Platform processes tasks independently for testing/validation
- Compare results to verify parity

### Stage 2: Platform Primary (Phase 4-5)

```
GitHub ──webhooks──▶ Platform Server (primary)
                     └── delegates to lib/ ReviewEngine
Probot App (standby, webhook disabled)
```

- Platform becomes the primary webhook handler
- Probot App kept as fallback (can be re-enabled)
- All features validated in production

### Stage 3: Full Migration (Phase 6)

```
GitHub ──webhooks──▶ Platform Server (sole handler)
Probot App (deprecated, code archived)
```

- Probot App code archived but not deleted
- `app/` package marked as deprecated in monorepo
- All webhook processing, review execution, and user interaction through Platform

---

## 13. Open Questions

> [!IMPORTANT]
> These need to be resolved before or during implementation. Mark each with a decision when resolved.

### Architecture

- [ ] **Q1**: Should the frontend (web dashboard) be a separate deployable or bundled into the platform server?
  - Option A: Separate Vite app deployed to S3/CloudFront (decoupled, CDN-cached)
  - Option B: Bundled and served by the platform server (simpler deployment)
  - **Recommendation**: Start with B (bundled), move to A when scaling

- [ ] **Q2**: Should we use the `@opencode-ai/client` SDK or make direct HTTP calls to `opencode serve`?
  - Option A: SDK (typed, maintained by OpenCode team)
  - Option B: Direct HTTP (no dependency, full control)
  - **Recommendation**: SDK for session management, direct HTTP for proxy

- [ ] **Q3**: How many concurrent `opencode serve` processes should we allow per instance?
  - Each process consumes ~100-200 MB RAM
  - t3.xlarge (16 GB) → max ~50-80 processes, practically 10-20 active
  - **Recommendation**: Configurable limit, default based on available RAM

### Data

- [ ] **Q4**: Should the platform use the existing `LearningStore` from `lib/` or create its own data layer?
  - **Recommendation**: Platform uses its own PostgreSQL for task/user/repo management; `LearningStore` continues for review findings/feedback per-workspace

- [ ] **Q5**: How long should archived data be retained in S3?
  - Option A: Indefinite
  - Option B: Configurable (30/90/365 days)
  - Option C: S3 lifecycle rules (move to Glacier after 90 days)
  - **Recommendation**: Option C — S3 Intelligent-Tiering

### Integration

- [ ] **Q6**: Should the platform support GitLab in addition to GitHub from the start?
  - The existing `lib/` already has `GitLabAdapter`
  - **Recommendation**: GitHub-first, GitLab support added after Phase 3

- [ ] **Q7**: Should we support connecting to self-hosted GitHub Enterprise?
  - Requires configurable GitHub API base URL
  - **Recommendation**: Yes, add to Phase 4 (config option for GHE URL)

### Infrastructure

- [ ] **Q8**: Domain name and DNS setup — what domain will this run on?
  - Needs: DNS A record → EC2 Elastic IP, or Route 53 → ALB
  - **Action needed**: Decide domain before Phase 2

- [ ] **Q9**: How will secrets (LLM API keys, GitHub App credentials) be managed?
  - Option A: `.env` file on EC2 (simple)
  - Option B: AWS Secrets Manager (secure, rotatable)
  - Option C: AWS SSM Parameter Store (cost-effective)
  - **Recommendation**: SSM Parameter Store for Tier 1-2, Secrets Manager for Tier 3

---

## Summary — Phase Execution Order

```
Phase 0 (Foundation)          ████████░░░░░░░░░░░░  Week 1-2
Phase 1 (Task Queue/Worker)   ░░░░░░░░████████████░  Week 2-4
Phase 2 (Dashboard/API)       ░░░░░░░░░░░░████████░  Week 4-6
Phase 3 (OpenCode Web)        ░░░░░░░░░░░░░░████████ Week 6-8
Phase 4 (Auth/Multi-User)     ░░░░░░░░░░░░░░░░████░░ Week 7-8
Phase 5 (Lifecycle/Cleanup)   ░░░░░░░░░░░░░░░░░████░ Week 8-9
Phase 6 (Scaling/Hardening)   ░░░░░░░░░░░░░░░░░░████ Week 9-11
```

**First usable MVP** (Phases 0-3): ~6-8 weeks
- GitHub webhooks trigger async reviews
- Web dashboard shows all tasks with real-time status
- Interactive OpenCode conversations from the browser
- Manual task creation from dashboard

**Full platform** (all phases): ~10-12 weeks
- Multi-user with GitHub OAuth
- Automatic workspace cleanup on PR merge
- S3 archival with configurable retention
- Production monitoring and scaling

---

> [!TIP]
> Start by resolving the **Open Questions** (Section 13), then proceed with Phase 0. Each phase can be reviewed and adjusted before moving to the next.
