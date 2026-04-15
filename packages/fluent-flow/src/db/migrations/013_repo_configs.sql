-- 013_repo_configs.sql

CREATE TABLE IF NOT EXISTS repo_configs (
  repo_id      TEXT PRIMARY KEY REFERENCES repos(id),
  default_agent TEXT,
  claim_types  JSONB,
  review_model TEXT,
  paused       BOOLEAN NOT NULL DEFAULT false,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
