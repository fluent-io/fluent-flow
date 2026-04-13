-- 015_org_config.sql
-- Per-org defaults that cascade into repo_configs at resolve time.

CREATE TABLE IF NOT EXISTS org_config (
  org_id TEXT PRIMARY KEY,
  default_agent TEXT,
  claim_types JSONB,
  review_model TEXT,
  paused BOOLEAN,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
