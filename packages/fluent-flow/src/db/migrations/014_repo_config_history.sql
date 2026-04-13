-- 014_repo_config_history.sql
-- Append-only audit of repo config changes. Diff stored as JSON Patch (RFC 6902).

CREATE TABLE IF NOT EXISTS repo_config_history (
  id BIGSERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL,
  repo_external_id BIGINT NOT NULL,
  patch JSONB NOT NULL,
  actor TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_config_history_repo
  ON repo_config_history(installation_id, repo_external_id, at DESC);
