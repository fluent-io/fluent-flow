ALTER TABLE collab_projects
  ADD COLUMN summary_execution_defaults jsonb NOT NULL
  DEFAULT '{"enabled":false,"agentId":null,"profileId":null,"model":null}'::jsonb;

ALTER TABLE collab_projects
  ADD CONSTRAINT collab_projects_summary_defaults_object
  CHECK (jsonb_typeof(summary_execution_defaults) = 'object');

ALTER TABLE agent_claims DROP CONSTRAINT agent_claims_chat_identity;
ALTER TABLE agent_claims ADD CONSTRAINT agent_claims_task_identity CHECK (
  (claim_type IS NOT DISTINCT FROM 'chat' AND task_id IS NOT NULL AND pr_number IS NULL AND pending_deadline_at IS NOT NULL)
  OR (claim_type IS NOT DISTINCT FROM 'summary' AND task_id IS NOT NULL AND repo IS NULL AND pr_number IS NULL AND target_agent_id IS NOT NULL)
  OR (claim_type IS DISTINCT FROM 'chat' AND claim_type IS DISTINCT FROM 'summary' AND repo IS NOT NULL AND task_id IS NULL)
);
CREATE UNIQUE INDEX agent_claims_summary_task_attempt ON agent_claims(org_id,task_id,attempt) WHERE claim_type='summary';

CREATE OR REPLACE FUNCTION enforce_chat_claim_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM collab_tasks t JOIN collab_projects p ON p.id=t.project_id
    JOIN collab_workspaces w ON w.id=p.workspace_id WHERE t.id=NEW.task_id AND w.org_id=NEW.org_id
  ) THEN RAISE EXCEPTION 'Invalid task claim identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_chat_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_claims c WHERE c.id=NEW.claim_id AND c.task_id IS NOT NULL) AND NOT EXISTS (
    SELECT 1 FROM agent_claims c JOIN collab_tasks t ON t.id=c.task_id
    WHERE c.id=NEW.claim_id AND t.id=NEW.task_id AND t.project_id=NEW.project_id
  ) THEN RAISE EXCEPTION 'Invalid task execution identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE TABLE collab_summary_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL REFERENCES collab_tasks(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES collab_projects(id) ON DELETE CASCADE,
  claim_id integer NOT NULL UNIQUE REFERENCES agent_claims(id),
  target_agent_id text NOT NULL,
  profile_id text NOT NULL,
  model text,
  task_title text NOT NULL,
  source_identity jsonb NOT NULL CHECK (jsonb_typeof(source_identity)='object'),
  source_cursor jsonb CHECK (source_cursor IS NULL OR jsonb_typeof(source_cursor)='object'),
  source_text text NOT NULL CHECK (char_length(source_text)<=60000),
  source_entry_count integer NOT NULL CHECK (source_entry_count BETWEEN 0 AND 100),
  source_truncated boolean NOT NULL,
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals(id),
  created_by_session_version integer NOT NULL CHECK (created_by_session_version>0),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,created_by_principal_id,idempotency_key)
);

CREATE FUNCTION enforce_summary_request_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_claims c JOIN collab_claim_executions e ON e.claim_id=c.id
    JOIN collab_tasks t ON t.id=e.task_id JOIN collab_projects p ON p.id=t.project_id
    JOIN collab_workspaces w ON w.id=p.workspace_id
    WHERE c.id=NEW.claim_id AND c.claim_type='summary' AND c.repo IS NULL AND c.pr_number IS NULL
      AND c.task_id=NEW.task_id AND e.task_id=NEW.task_id AND t.project_id=NEW.project_id AND e.project_id=NEW.project_id
      AND c.org_id=NEW.org_id AND w.org_id=NEW.org_id AND c.target_agent_id=NEW.target_agent_id
      AND e.created_by_principal_id=NEW.created_by_principal_id AND e.created_by_session_version=NEW.created_by_session_version
  ) THEN RAISE EXCEPTION 'Invalid summary request identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_summary_requests_identity BEFORE INSERT ON collab_summary_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_summary_request_identity();

CREATE FUNCTION protect_summary_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Summary requests are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER collab_summary_requests_immutable BEFORE UPDATE ON collab_summary_requests
  FOR EACH ROW EXECUTE FUNCTION protect_summary_request();

CREATE TABLE collab_summary_claims (
  claim_id integer PRIMARY KEY REFERENCES agent_claims(id),
  summary_request_id uuid NOT NULL REFERENCES collab_summary_requests(id) ON DELETE CASCADE,
  parent_claim_id integer REFERENCES agent_claims(id)
);
CREATE INDEX collab_summary_claims_request ON collab_summary_claims(summary_request_id,claim_id);

CREATE FUNCTION enforce_summary_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM collab_summary_requests r JOIN agent_claims c ON c.id=NEW.claim_id
    JOIN collab_claim_executions e ON e.claim_id=c.id
    JOIN collab_claim_executions original ON original.claim_id=r.claim_id
    WHERE r.id=NEW.summary_request_id AND c.claim_type='summary' AND c.repo IS NULL AND c.pr_number IS NULL
      AND c.task_id=r.task_id AND c.org_id=r.org_id AND c.target_agent_id=r.target_agent_id
      AND e.task_id=r.task_id AND e.project_id=r.project_id AND e.root_claim_id=original.root_claim_id
      AND e.created_by_principal_id=r.created_by_principal_id AND e.created_by_session_version=r.created_by_session_version
      AND c.payload->>'summary_request_id'=r.id::text AND c.payload->>'profile'=r.profile_id
      AND (c.payload->>'model') IS NOT DISTINCT FROM r.model
      AND ((NEW.parent_claim_id IS NULL AND c.id=r.claim_id) OR EXISTS (
        SELECT 1 FROM collab_summary_claims previous JOIN agent_claims parent ON parent.id=previous.claim_id
        WHERE previous.claim_id=NEW.parent_claim_id AND previous.summary_request_id=r.id AND parent.org_id=r.org_id
          AND parent.claim_type='summary' AND parent.status IN ('failed','expired') AND parent.id<>c.id
      ))
  ) THEN RAISE EXCEPTION 'Invalid summary attempt identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_summary_claims_identity BEFORE INSERT ON collab_summary_claims
  FOR EACH ROW EXECUTE FUNCTION enforce_summary_attempt_identity();
CREATE TRIGGER collab_summary_claims_immutable BEFORE UPDATE ON collab_summary_claims
  FOR EACH ROW EXECUTE FUNCTION protect_summary_request();

ALTER TABLE collab_summaries ADD COLUMN summary_request_id uuid REFERENCES collab_summary_requests(id);
ALTER TABLE collab_summaries ADD CONSTRAINT collab_summaries_native_source CHECK (
  (claim_id IS NULL AND summary_request_id IS NULL)
  OR (claim_id IS NOT NULL AND summary_request_id IS NOT NULL AND run_id IS NULL AND session_id IS NULL AND visibility='internal')
);
CREATE UNIQUE INDEX collab_summaries_one_native_result ON collab_summaries(claim_id) WHERE claim_id IS NOT NULL;
CREATE UNIQUE INDEX collab_summaries_one_request_result ON collab_summaries(summary_request_id) WHERE summary_request_id IS NOT NULL;
