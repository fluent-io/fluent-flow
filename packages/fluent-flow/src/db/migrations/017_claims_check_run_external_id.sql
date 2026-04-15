-- Add check_run_external_id to agent_claims for GitHub Check Run integration
ALTER TABLE agent_claims
  ADD COLUMN IF NOT EXISTS check_run_external_id BIGINT,
  ADD COLUMN IF NOT EXISTS head_sha TEXT;
