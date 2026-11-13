CREATE TABLE agent_claim_workspaces (
  claim_id integer PRIMARY KEY REFERENCES agent_claims(id),
  retained boolean NOT NULL,
  reason text NOT NULL CHECK (reason IN ('dirty','unpushed','scratch','clean_pushed','inspection_failed','preparation_failed')),
  reported_at timestamptz NOT NULL DEFAULT now(),
  CHECK (retained = (reason <> 'clean_pushed'))
);
