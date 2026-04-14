-- 015_org_config.sql

CREATE TABLE IF NOT EXISTS org_config (
  org_id               TEXT PRIMARY KEY REFERENCES orgs(id),
  default_review_model TEXT,
  default_claim_types  JSONB,
  default_agent        TEXT,
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
