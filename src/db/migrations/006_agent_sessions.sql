CREATE TABLE IF NOT EXISTS agent_sessions (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_id      TEXT NOT NULL,
  session_meta  JSONB DEFAULT '{}',
  status        TEXT DEFAULT 'online',
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_active
  ON agent_sessions(org_id, agent_id, status) WHERE status = 'online';
