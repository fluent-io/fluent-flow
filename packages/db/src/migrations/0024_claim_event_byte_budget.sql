ALTER TABLE agent_claim_events
  ADD COLUMN payload_bytes integer
    GENERATED ALWAYS AS (octet_length(payload::text)) STORED NOT NULL,
  ADD CONSTRAINT agent_claim_events_payload_bytes_check CHECK (payload_bytes >= 0);
