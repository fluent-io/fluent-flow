-- Backfill archived_at for existing terminal-state claims that were completed/failed/expired
-- before archived_at was being set on those transitions.
UPDATE agent_claims
SET archived_at = COALESCE(completed_at, created_at, NOW())
WHERE status IN ('completed', 'failed', 'expired')
  AND archived_at IS NULL;
