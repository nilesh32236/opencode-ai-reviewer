-- OpenCode Platform — migration 002: webhook delivery deduplication.
--
-- GitHub may redeliver a webhook payload (X-GitHub-Delivery is unique per
-- delivery). The receiver inserts each delivery id here before processing and
-- skips already-seen ids, so a redelivery never double-enqueues a task.

CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id   TEXT NOT NULL UNIQUE,   -- X-GitHub-Delivery header
  event_type    TEXT NOT NULL,          -- e.g. pull_request, issue_comment
  repo          TEXT NOT NULL,          -- owner/repo
  payload       JSONB NOT NULL,
  processed     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_repo ON webhook_events(repo);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at DESC);
