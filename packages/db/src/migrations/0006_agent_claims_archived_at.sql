-- Add archived_at timestamp to agent_claims for dismiss/archive support
ALTER TABLE agent_claims ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;

-- Index for filtering out archived claims in pipeline listings
CREATE INDEX IF NOT EXISTS idx_agent_claims_not_archived
  ON agent_claims (org_id, repo, pr_number)
  WHERE archived_at IS NULL;
