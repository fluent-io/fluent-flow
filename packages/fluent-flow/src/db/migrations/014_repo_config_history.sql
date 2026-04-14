-- 014_repo_config_history.sql

CREATE TABLE IF NOT EXISTS repo_config_history (
  id      SERIAL PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  patch   JSONB NOT NULL,
  actor   TEXT,
  at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_config_history_repo_id_at
  ON repo_config_history(repo_id, at DESC);
