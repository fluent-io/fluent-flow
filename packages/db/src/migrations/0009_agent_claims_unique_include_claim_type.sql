-- Drop and recreate the main unique index to include claim_type.
-- This allows different claim types (review_fix, test_verify, review, etc.)
-- to coexist at the same attempt number for the same PR.
--
-- The index is NOT partial: a partial index (WHERE pr_number IS NOT NULL)
-- cannot be used as the arbiter for `INSERT ... ON CONFLICT (cols)` because
-- Postgres requires the predicate to appear in the conflict target, but
-- Drizzle's `target: [columns]` form emits no predicate. NULL pr_number rows
-- are still uniqueness-isolated by the no-pr partial index below (NULLs are
-- distinct in btree unique indexes by default).
-- Use ALTER TABLE DROP CONSTRAINT because the original index was created as
-- a UNIQUE CONSTRAINT (not a plain unique index). DROP INDEX fails with
-- "cannot drop index because constraint requires it" in that case.
ALTER TABLE agent_claims DROP CONSTRAINT IF EXISTS agent_claims_org_id_repo_pr_number_attempt_key;
DROP INDEX IF EXISTS agent_claims_org_id_repo_pr_number_attempt_key;

CREATE UNIQUE INDEX agent_claims_org_id_repo_pr_number_attempt_key
  ON agent_claims (org_id, repo, pr_number, claim_type, attempt);

-- Drop and recreate the partial unique index for NULL pr_number to include claim_type.
DROP INDEX IF EXISTS agent_claims_org_repo_attempt_no_pr_key;

CREATE UNIQUE INDEX agent_claims_org_repo_attempt_no_pr_key
  ON agent_claims (org_id, repo, claim_type, attempt)
  WHERE pr_number IS NULL;
