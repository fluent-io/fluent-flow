-- 010_provider_installations.sql

-- repos: identity table for GitHub repos (keyed by provider + external id)
CREATE TABLE IF NOT EXISTS repos (
  id               TEXT PRIMARY KEY,          -- "owner/repo" format
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  repo_external_id BIGINT,
  repo_full_name   TEXT NOT NULL,
  provider         TEXT NOT NULL DEFAULT 'github',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repos_org_id ON repos(org_id);
CREATE INDEX IF NOT EXISTS idx_repos_repo_external_id ON repos(repo_external_id);

CREATE TABLE IF NOT EXISTS provider_installations (
  id                       BIGSERIAL PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES orgs(id),
  provider                 TEXT NOT NULL DEFAULT 'github' CHECK (provider = 'github'),
  external_installation_id BIGINT NOT NULL,
  account_login            TEXT NOT NULL,
  account_type             TEXT NOT NULL,
  installed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at             TIMESTAMPTZ,
  permissions              JSONB NOT NULL DEFAULT '{}',
  events                   JSONB NOT NULL DEFAULT '[]',
  UNIQUE (provider, external_installation_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_installations_org_id
  ON provider_installations(org_id);

CREATE INDEX IF NOT EXISTS idx_provider_installations_external_id
  ON provider_installations(external_installation_id);
