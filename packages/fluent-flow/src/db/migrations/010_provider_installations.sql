-- 010_provider_installations.sql
-- GitHub App installation tracking (first implementation of the provider abstraction).

CREATE TABLE IF NOT EXISTS provider_installations (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',
  external_installation_id BIGINT NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at TIMESTAMPTZ,
  UNIQUE (provider, external_installation_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_installations_org_id ON provider_installations(org_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_installations_provider_check'
  ) THEN
    ALTER TABLE provider_installations ADD CONSTRAINT provider_installations_provider_check
      CHECK (provider IN ('github'));
  END IF;
END $$;
