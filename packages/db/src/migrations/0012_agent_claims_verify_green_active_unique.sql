-- packages/db/src/migrations/0012_agent_claims_verify_green_active_unique.sql
-- Forward-only: scope the per-SHA green uniqueness to ACTIVE claims.
--
-- 0010 created idx_agent_claims_verify_green_per_sha without a status
-- predicate, so any TERMINAL green claim (expired / failed / completed) at
-- head_sha X keeps blocking ON CONFLICT DO NOTHING inserts for that SHA
-- forever: redispatchClaim can never create attempt+1 for a green infra
-- failure and transient failures escalate to needs-human on the first hit
-- instead of retrying under MAX_RETRY_ATTEMPTS.
--
-- Restricting the predicate to pending/claimed preserves both guarantees:
--   1. two ACTIVE greens for one SHA can never coexist — webhook redelivery
--      stays idempotent (createGreenClaim's duplicate SELECT is status-agnostic);
--   2. terminal claims free the SHA so attempt+1 at the same head_sha inserts.

DROP INDEX IF EXISTS idx_agent_claims_verify_green_per_sha;
CREATE UNIQUE INDEX idx_agent_claims_verify_green_per_sha
  ON agent_claims (org_id, repo, pr_number, head_sha)
  WHERE claim_type = 'verify' AND payload->>'phase' = 'green'
    AND status IN ('pending', 'claimed');
