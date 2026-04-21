-- Supports both the periodic expireSessions() worker and every routing query
-- that filters `status <> 'offline' AND expires_at > NOW()`. Partial index so
-- it stays tight: offline rows accumulate forever but we never seek them via
-- this path, only the live rows bounded by active agent count.
--
-- CREATE INDEX IF NOT EXISTS keeps this safe on databases that were stamped
-- at an earlier baseline and may already have the index applied manually.
CREATE INDEX IF NOT EXISTS "idx_agent_sessions_expires_at_live"
  ON "agent_sessions" ("expires_at")
  WHERE "status" <> 'offline';
