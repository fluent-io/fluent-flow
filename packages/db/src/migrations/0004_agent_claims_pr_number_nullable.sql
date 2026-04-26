-- Make pr_number nullable in agent_claims to support feature/spec claims without a PR.
-- Postgres unique indexes exclude NULL values by default, so NULL pr_numbers
-- won't conflict in the agent_claims_org_id_repo_pr_number_attempt_key index.

ALTER TABLE agent_claims ALTER COLUMN pr_number DROP NOT NULL;

-- Index for efficiently querying pending/claimed claims that have no PR number
CREATE INDEX idx_agent_claims_active_no_pr
  ON agent_claims (org_id, repo)
  WHERE status = ANY (ARRAY['pending', 'claimed']) AND pr_number IS NULL;
