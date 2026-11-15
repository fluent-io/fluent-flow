ALTER TABLE collab_usage_samples ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE collab_usage_samples ADD COLUMN reporting_binding_id uuid;
ALTER TABLE collab_usage_samples ADD CONSTRAINT collab_usage_native_source
  CHECK (reporting_binding_id IS NULL OR (claim_id IS NOT NULL AND run_id IS NULL AND session_id IS NULL));
CREATE UNIQUE INDEX collab_usage_samples_bound_native
  ON collab_usage_samples (reporting_binding_id, provider_turn_id)
  WHERE reporting_binding_id IS NOT NULL;
ALTER TABLE collab_usage_samples ADD COLUMN source_event_seq bigint;
ALTER TABLE collab_usage_samples ADD CONSTRAINT collab_usage_source_event
  CHECK (source_event_seq IS NULL OR (reporting_binding_id IS NOT NULL AND source_event_seq >= 0));
ALTER TABLE agent_claim_events ADD COLUMN reporting_binding_id uuid;
CREATE INDEX agent_claim_events_usage_source
  ON agent_claim_events (org_id, claim_id, reporting_binding_id, seq DESC)
  WHERE kind = 'usage';
ALTER TABLE collab_usage_samples ADD COLUMN sample_kind text NOT NULL DEFAULT 'turn';
ALTER TABLE collab_usage_samples ADD CONSTRAINT collab_usage_sample_kind
  CHECK (sample_kind = 'turn' OR (sample_kind = 'session_snapshot' AND reporting_binding_id IS NOT NULL AND source_event_seq IS NOT NULL));
