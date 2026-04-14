-- 012_provider_outbound_queue.sql

CREATE TABLE IF NOT EXISTS provider_outbound_queue (
  id                      SERIAL PRIMARY KEY,
  installation_id         INTEGER NOT NULL REFERENCES provider_installations(id) ON DELETE CASCADE,
  kind                    TEXT NOT NULL,
  payload                 JSONB NOT NULL DEFAULT '{}',
  client_ref              TEXT NOT NULL UNIQUE,
  attempts                INTEGER NOT NULL DEFAULT 0,
  rate_limited_attempts   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error              TEXT,
  succeeded_at            TIMESTAMPTZ,
  parked_at               TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbound_queue_next_attempt
  ON provider_outbound_queue(next_attempt_at)
  WHERE succeeded_at IS NULL AND parked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_queue_installation_id
  ON provider_outbound_queue(installation_id);
