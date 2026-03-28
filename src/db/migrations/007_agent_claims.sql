CREATE TABLE IF NOT EXISTS agent_claims (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  repo          TEXT NOT NULL,
  pr_number     INT NOT NULL,
  attempt       INT NOT NULL,
  session_id    INT REFERENCES agent_sessions(id),
  claim_type    TEXT DEFAULT 'review_fix',
  status        TEXT DEFAULT 'pending',
  payload       JSONB DEFAULT '{}',
  claimed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, repo, pr_number, attempt)
);

CREATE INDEX IF NOT EXISTS idx_agent_claims_active
  ON agent_claims(org_id, repo, pr_number) WHERE status IN ('pending', 'claimed');
