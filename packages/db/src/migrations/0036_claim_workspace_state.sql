CREATE TABLE collab_claim_workspace_state (
  reporting_binding_id uuid PRIMARY KEY REFERENCES collab_scoped_tokens(id),
  last_seq bigint NOT NULL CHECK (last_seq > 0),
  state text NOT NULL CHECK (state IN ('known', 'not_repository', 'unavailable')),
  head_commit text CHECK (head_commit ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  dirty boolean,
  final boolean NOT NULL,
  proof_hash text NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'known' AND head_commit IS NOT NULL AND dirty IS NOT NULL)
    OR (state <> 'known' AND head_commit IS NULL AND dirty IS NULL))
);

ALTER TABLE collab_check_evidence
  ADD COLUMN reporting_binding_id uuid REFERENCES collab_scoped_tokens(id),
  ADD COLUMN workspace_seq bigint CHECK (workspace_seq > 0),
  ADD CONSTRAINT collab_check_native_source CHECK (reporting_binding_id IS NULL
    OR (claim_id IS NOT NULL AND run_id IS NULL AND session_id IS NULL));

ALTER TABLE collab_artifacts
  ADD COLUMN reporting_binding_id uuid REFERENCES collab_scoped_tokens(id),
  ADD CONSTRAINT collab_artifact_native_source CHECK (reporting_binding_id IS NULL
    OR (claim_id IS NOT NULL AND run_id IS NULL AND session_id IS NULL));
