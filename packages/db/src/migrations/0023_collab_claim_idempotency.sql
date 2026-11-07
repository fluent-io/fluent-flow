ALTER TABLE collab_idempotency_records
  ALTER COLUMN resource_id DROP NOT NULL,
  ADD COLUMN claim_id integer REFERENCES agent_claims(id) ON DELETE CASCADE,
  ADD CONSTRAINT collab_idempotency_records_exactly_one_resource
    CHECK ((resource_id IS NOT NULL)::integer + (claim_id IS NOT NULL)::integer = 1);
