CREATE TABLE collab_claim_read_cursors (
  org_id text NOT NULL,
  claim_id integer NOT NULL REFERENCES agent_claims(id),
  principal_id uuid NOT NULL REFERENCES collab_principals(id),
  last_seq integer NOT NULL CHECK (last_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, claim_id, principal_id)
);
