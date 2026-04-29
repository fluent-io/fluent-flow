-- Backfill archived_at for terminal claims and completed_at for expired claims
-- so downstream consumers don't treat them as still in progress.
UPDATE agent_claims
SET archived_at = COALESCE(archived_at, completed_at, created_at, NOW()),
    completed_at = CASE
        WHEN status = 'expired' THEN COALESCE(completed_at, archived_at, created_at, NOW())
        ELSE completed_at
    END
WHERE status IN ('completed', 'failed', 'expired')
  AND (
      archived_at IS NULL
      OR (status = 'expired' AND completed_at IS NULL)
  );
