-- 013_repo_configs.sql
-- DB-backed repo config (replaces .fluent-flow/config.yaml on default branch).
-- Keyed by (installation_id, repo_external_id) — no separate repos table.

CREATE TABLE IF NOT EXISTS repo_configs (
  installation_id BIGINT NOT NULL REFERENCES provider_installations(id) ON DELETE CASCADE,
  repo_external_id BIGINT NOT NULL,
  default_agent TEXT NOT NULL,
  claim_types JSONB NOT NULL,
  review_model TEXT NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (installation_id, repo_external_id)
);
