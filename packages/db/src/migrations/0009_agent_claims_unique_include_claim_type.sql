-- Drop and recreate the main unique index to include claim_type.
-- This allows different claim types (review_fix, test_verify, review, etc.)
-- to coexist at the same attempt number for the same PR.
DROP INDEX IF EXISTS agent_claims_org_id_repo_pr_number_attempt_key;

CREATE UNIQUE INDEX agent_claims_org_id_repo_pr_number_attempt_key
  ON agent_claims (org_id, repo, pr_number, claim_type, attempt)
  WHERE pr_number IS NOT NULL;

-- Drop and recreate the partial unique index for NULL pr_number to include claim_type.
DROP INDEX IF EXISTS agent_claims_org_repo_attempt_no_pr_key;

CREATE UNIQUE INDEX agent_claims_org_repo_attempt_no_pr_key
  ON agent_claims (org_id, repo, claim_type, attempt)
  WHERE pr_number IS NULL;
