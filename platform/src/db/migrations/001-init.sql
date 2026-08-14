-- OpenCode Platform — PostgreSQL schema (migration 001)
-- Core tables for task orchestration, repository management, and
-- conversation/session tracking. Applied by the migration runner in db/client.ts.

-- Users identified by their GitHub identity.
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     BIGINT UNIQUE NOT NULL,
  github_login  TEXT NOT NULL,
  avatar_url    TEXT,
  role          TEXT NOT NULL DEFAULT 'reviewer', -- admin, reviewer, viewer
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repositories the platform is configured to review.
CREATE TABLE IF NOT EXISTS repositories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     BIGINT UNIQUE NOT NULL,
  owner         TEXT NOT NULL,
  name          TEXT NOT NULL,
  full_name     TEXT NOT NULL, -- owner/name
  webhook_id    BIGINT,        -- GitHub webhook ID (for management)
  config        JSONB NOT NULL DEFAULT '{}', -- repo-specific review config overrides
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner, name)
);

-- Task type/status enums from PLATFORM-PLAN §4.3.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_type') THEN
    CREATE TYPE task_type AS ENUM ('review', 'fix', 'audit', 'analyze', 'docs', 'conversation');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_status') THEN
    CREATE TYPE task_status AS ENUM (
      'queued', 'cloning', 'running', 'waiting_input',
      'completed', 'failed', 'cancelled', 'archiving', 'archived'
    );
  END IF;
END$$;

-- Async review/fix/audit tasks.
CREATE TABLE IF NOT EXISTS tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id           UUID REFERENCES repositories(id) ON DELETE CASCADE,
  type              task_type NOT NULL,
  status            task_status NOT NULL DEFAULT 'queued',
  priority          INT NOT NULL DEFAULT 0,
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
  triggered_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  trigger_source    TEXT NOT NULL DEFAULT 'webhook', -- webhook, manual, schedule
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OpenCode conversation sessions bound to tasks.
CREATE TABLE IF NOT EXISTS conversations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID REFERENCES tasks(id) ON DELETE CASCADE,
  opencode_session  TEXT,          -- OpenCode session ID
  title             TEXT,
  status            TEXT NOT NULL DEFAULT 'active', -- active, archived, deleted
  archived_s3_key   TEXT,          -- S3 key for archived conversation data
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Task lifecycle event log (status changes, findings, errors).
CREATE TABLE IF NOT EXISTS task_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID REFERENCES tasks(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,  -- status_change, log, error, finding
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries (from PLATFORM-PLAN §4.3).
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id);
CREATE INDEX IF NOT EXISTS idx_tasks_pr ON tasks(repo_id, pr_number);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_conversations_task ON conversations(task_id);
CREATE INDEX IF NOT EXISTS idx_repositories_full_name ON repositories(full_name);
