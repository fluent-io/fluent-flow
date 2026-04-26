-- Partial unique index to prevent duplicate standalone claims (pr_number IS NULL).
-- The main unique index (org_id, repo, pr_number, attempt) doesn't prevent
-- duplicates when pr_number is NULL because Postgres treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_claims_org_repo_attempt_no_pr_key"
  ON "agent_claims" ("org_id", "repo", "attempt")
  WHERE "pr_number" IS NULL;
