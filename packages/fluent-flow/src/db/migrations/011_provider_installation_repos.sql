-- 011_provider_installation_repos.sql

CREATE TABLE IF NOT EXISTS provider_installation_repos (
  id               SERIAL PRIMARY KEY,
  installation_id  INTEGER NOT NULL REFERENCES provider_installations(id) ON DELETE CASCADE,
  repo_external_id BIGINT NOT NULL,
  repo_full_name   TEXT NOT NULL,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at       TIMESTAMPTZ,
  UNIQUE (installation_id, repo_external_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_installation_repos_repo_external_id
  ON provider_installation_repos(repo_external_id);

CREATE INDEX IF NOT EXISTS idx_provider_installation_repos_installation_id
  ON provider_installation_repos(installation_id);
