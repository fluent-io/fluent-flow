ALTER TABLE agent_claim_events
  ADD COLUMN payload_bytes integer;

ALTER TABLE agent_claim_events
  ADD CONSTRAINT agent_claim_events_payload_bytes_not_null
    CHECK (payload_bytes IS NOT NULL) NOT VALID;

ALTER TABLE agent_claim_events
  ADD CONSTRAINT agent_claim_events_payload_bytes_check
    CHECK (payload_bytes >= 0) NOT VALID;
