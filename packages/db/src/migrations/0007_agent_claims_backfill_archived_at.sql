-- Backfill completed_at for expired claims
-- so downstream consumers don't treat them as still in progress.
UPDATE agent_claims
SET completed_at = COALESCE(completed_at, archived_at, created_at, NOW())
WHERE status = 'expired'
  AND completed_at IS NULL;
