-- 012_provider_outbound_queue.sql
-- Durable queue for all outbound provider writes (comments, reviews, check runs).

CREATE TABLE IF NOT EXISTS provider_outbound_queue (
  id BIGSERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES provider_installations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  client_ref TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  rate_limited_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  succeeded_at TIMESTAMPTZ,
  parked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index covers the worker's claim query.
CREATE INDEX IF NOT EXISTS idx_provider_outbound_queue_ready
  ON provider_outbound_queue(next_attempt_at)
  WHERE succeeded_at IS NULL AND parked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_provider_outbound_queue_installation
  ON provider_outbound_queue(installation_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_outbound_queue_kind_check'
  ) THEN
    ALTER TABLE provider_outbound_queue ADD CONSTRAINT provider_outbound_queue_kind_check
      CHECK (kind IN ('comment', 'review', 'check_run.create', 'check_run.update'));
  END IF;
END $$;
