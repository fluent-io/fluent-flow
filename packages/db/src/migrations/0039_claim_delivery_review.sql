ALTER TABLE agent_claim_requests ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX agent_claim_requests_identity ON agent_claim_requests(id);
