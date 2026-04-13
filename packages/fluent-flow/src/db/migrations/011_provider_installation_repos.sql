-- 011_provider_installation_repos.sql
-- Repos discovered via installation_repositories webhook. Acts as the repo-identity table.

CREATE TABLE IF NOT EXISTS provider_installation_repos (
  id BIGSERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES provider_installations(id) ON DELETE CASCADE,
  repo_external_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ
);

-- Only one live row per (installation, repo) — cross-installation transfers are modeled via
-- marking the old row removed and adding a new one under the new installation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_installation_repos_live
  ON provider_installation_repos(installation_id, repo_external_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_provider_installation_repos_external
  ON provider_installation_repos(repo_external_id);
