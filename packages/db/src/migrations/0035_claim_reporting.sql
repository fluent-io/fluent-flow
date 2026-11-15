ALTER TABLE collab_claim_executions ADD COLUMN created_by_session_version integer CHECK (created_by_session_version IS NULL OR created_by_session_version >= 1);

ALTER TABLE collab_scoped_tokens ADD COLUMN claim_id integer REFERENCES agent_claims (id);
ALTER TABLE collab_scoped_tokens ADD COLUMN claimed_at timestamptz;
ALTER TABLE collab_scoped_tokens ADD COLUMN runner_session_id integer;
ALTER TABLE collab_scoped_tokens ADD COLUMN task_id uuid REFERENCES collab_tasks (id);
ALTER TABLE collab_scoped_tokens ADD COLUMN agent_token_id integer;
ALTER TABLE collab_scoped_tokens ADD COLUMN creator_session_version integer;

ALTER TABLE collab_scoped_tokens ADD CONSTRAINT collab_scoped_tokens_native_identity CHECK (
  (claim_id IS NULL AND claimed_at IS NULL AND runner_session_id IS NULL AND task_id IS NULL
    AND agent_token_id IS NULL AND creator_session_version IS NULL)
  OR (claim_id IS NOT NULL AND claimed_at IS NOT NULL AND runner_session_id IS NOT NULL AND task_id IS NOT NULL
    AND agent_token_id IS NOT NULL AND creator_session_version IS NOT NULL
    AND project_id IS NOT NULL AND run_id IS NULL AND session_id IS NULL)
);
CREATE UNIQUE INDEX collab_scoped_tokens_claim_acquisition
  ON collab_scoped_tokens (claim_id, claimed_at, runner_session_id) WHERE claim_id IS NOT NULL;

ALTER TABLE collab_check_evidence ADD COLUMN claim_id integer REFERENCES agent_claims (id);
ALTER TABLE collab_check_evidence DROP CONSTRAINT collab_check_evidence_provenance_bounds;
ALTER TABLE collab_check_evidence ADD CONSTRAINT collab_check_evidence_provenance_bounds CHECK (
  provenance = 'human'
  OR (provenance IN ('agent', 'runner') AND (run_id IS NOT NULL OR claim_id IS NOT NULL))
);
ALTER TABLE collab_artifacts ADD COLUMN claim_id integer REFERENCES agent_claims (id);
ALTER TABLE collab_artifacts ADD COLUMN captured_content bytea;
ALTER TABLE collab_artifacts ADD CONSTRAINT collab_artifacts_captured_content CHECK (
  captured_content IS NULL
  OR (kind = 'file' AND claim_id IS NOT NULL AND sha256 IS NOT NULL AND size_bytes = octet_length(captured_content)
    AND octet_length(captured_content) <= 524288)
);
ALTER TABLE collab_ideas ADD COLUMN claim_id integer REFERENCES agent_claims (id);
ALTER TABLE collab_workpad_plans ADD COLUMN claim_id integer REFERENCES agent_claims (id);
ALTER TABLE collab_open_questions ADD COLUMN claim_id integer REFERENCES agent_claims (id);
ALTER TABLE collab_summaries ADD COLUMN claim_id integer REFERENCES agent_claims (id);
ALTER TABLE collab_summaries ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE collab_usage_samples ADD COLUMN claim_id integer REFERENCES agent_claims (id);
ALTER TABLE collab_usage_samples ALTER COLUMN run_id DROP NOT NULL;
