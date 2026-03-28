-- Orgs: multi-tenant root
CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Agents: admin-managed identities
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT NOT NULL,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_type    TEXT NOT NULL,
  transport     TEXT NOT NULL,
  transport_meta JSONB DEFAULT '{}',
  repos         TEXT[] DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, id)
);

-- Agent tokens: auth for runners and API
CREATE TABLE IF NOT EXISTS agent_tokens (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_id      TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  label         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_lookup
  ON agent_tokens(org_id, agent_id) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tokens_hash_active
  ON agent_tokens(token_hash) WHERE revoked_at IS NULL;
