-- OpenCode Platform — migration 003: store the repo string on tasks.
--
-- The worker needs "owner/repo" to clone and to construct the GitHub adapter,
-- but tasks only had a repo_id FK. Denormalize the full name so retries and
-- the dashboard can reconstruct the workspace without joining repositories.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repo TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_repo_name ON tasks(repo);
