ALTER TABLE agent_claim_commands DROP CONSTRAINT agent_claim_commands_kind_check;
ALTER TABLE agent_claim_commands ADD CONSTRAINT agent_claim_commands_kind_check
  CHECK (kind IN ('prompt','cancel','end_session','handoff','permission','elicitation'));
CREATE TABLE collab_claim_handoffs (
  command_id integer PRIMARY KEY REFERENCES agent_claim_commands(id),
  task_id uuid NOT NULL REFERENCES collab_tasks(id),
  claim_id integer NOT NULL UNIQUE REFERENCES agent_claims(id),
  principal_id uuid NOT NULL REFERENCES collab_principals(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
