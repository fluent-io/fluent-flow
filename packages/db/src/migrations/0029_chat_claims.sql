ALTER TABLE agent_claims ALTER COLUMN repo DROP NOT NULL;
ALTER TABLE agent_claims ADD COLUMN task_id uuid REFERENCES collab_tasks(id);
ALTER TABLE agent_claims ADD COLUMN target_agent_id text;
ALTER TABLE agent_claims ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE agent_claims ADD COLUMN pending_deadline_at timestamptz;
ALTER TABLE agent_claims ADD COLUMN idle_timeout_seconds integer NOT NULL DEFAULT 900 CHECK (idle_timeout_seconds > 0);
ALTER TABLE agent_claims ADD COLUMN end_reason text CHECK (end_reason IN ('user','idle','no_capacity','max_duration','host_lost'));
ALTER TABLE agent_claims ADD CONSTRAINT agent_claims_target_agent_fk
  FOREIGN KEY (org_id, target_agent_id) REFERENCES agents(org_id,id);
ALTER TABLE agent_claims ADD CONSTRAINT agent_claims_chat_identity CHECK (
  (claim_type IS NOT DISTINCT FROM 'chat' AND task_id IS NOT NULL AND pr_number IS NULL AND pending_deadline_at IS NOT NULL)
  OR (claim_type IS DISTINCT FROM 'chat' AND repo IS NOT NULL AND task_id IS NULL)
);
CREATE UNIQUE INDEX agent_claims_one_active_chat_per_task ON agent_claims(org_id,task_id)
  WHERE claim_type = 'chat' AND status IN ('pending','claimed');
CREATE UNIQUE INDEX agent_claims_chat_task_attempt ON agent_claims(org_id,task_id,attempt) WHERE claim_type = 'chat';
DROP INDEX agent_claims_org_id_repo_pr_number_attempt_key;
CREATE UNIQUE INDEX agent_claims_org_id_repo_pr_number_attempt_key
  ON agent_claims(org_id,repo,pr_number,claim_type,attempt) WHERE claim_type IS DISTINCT FROM 'chat';
DROP INDEX agent_claims_org_repo_attempt_no_pr_key;
CREATE UNIQUE INDEX agent_claims_org_repo_attempt_no_pr_key
  ON agent_claims(org_id,repo,claim_type,attempt) WHERE pr_number IS NULL AND claim_type IS DISTINCT FROM 'chat';
ALTER TABLE agents ADD COLUMN max_chat_slots integer CHECK (max_chat_slots BETWEEN 0 AND 15);
ALTER TABLE collab_projects ADD COLUMN default_agent_id text;
ALTER TABLE collab_projects ADD COLUMN execution_mode text NOT NULL DEFAULT 'connector' CHECK (execution_mode IN ('chat','connector'));
ALTER TABLE collab_projects ALTER COLUMN execution_mode SET DEFAULT 'chat';
ALTER TABLE collab_projects ADD COLUMN chat_pending_ttl_seconds integer NOT NULL DEFAULT 120 CHECK (chat_pending_ttl_seconds > 0);
ALTER TABLE collab_projects ADD COLUMN chat_idle_timeout_seconds integer NOT NULL DEFAULT 900 CHECK (chat_idle_timeout_seconds > 0);
ALTER TABLE agent_claim_commands ADD COLUMN originator_principal_id uuid REFERENCES collab_principals(id);
ALTER TABLE agent_claim_commands ADD COLUMN originator_session_version integer;
ALTER TABLE agent_claim_commands DROP CONSTRAINT agent_claim_commands_kind_check;
ALTER TABLE agent_claim_commands ADD CONSTRAINT agent_claim_commands_kind_check CHECK (kind IN ('prompt','cancel','end_session','permission','elicitation'));

CREATE FUNCTION enforce_chat_claim_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.claim_type = 'chat' AND NOT EXISTS (
    SELECT 1 FROM collab_tasks t JOIN collab_projects p ON p.id=t.project_id
    JOIN collab_workspaces w ON w.id=p.workspace_id
    WHERE t.id=NEW.task_id AND w.org_id=NEW.org_id
  ) THEN RAISE EXCEPTION 'Invalid chat claim identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_claims_chat_identity BEFORE INSERT OR UPDATE OF task_id,org_id,claim_type ON agent_claims
  FOR EACH ROW EXECUTE FUNCTION enforce_chat_claim_identity();
CREATE FUNCTION enforce_chat_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_claims c WHERE c.id=NEW.claim_id AND c.claim_type='chat') AND NOT EXISTS (
    SELECT 1 FROM agent_claims c JOIN collab_tasks t ON t.id=c.task_id
    WHERE c.id=NEW.claim_id AND t.id=NEW.task_id AND t.project_id=NEW.project_id
  ) THEN RAISE EXCEPTION 'Invalid chat execution identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_claim_executions_chat_identity BEFORE INSERT OR UPDATE ON collab_claim_executions
  FOR EACH ROW EXECUTE FUNCTION enforce_chat_execution_identity();

CREATE FUNCTION chat_slot_available(p_org text, p_agent text, p_capacity integer)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE configured integer; active integer;
BEGIN
  SELECT max_chat_slots INTO configured FROM agents WHERE org_id=p_org AND id=p_agent FOR UPDATE;
  SELECT count(*) INTO active FROM agent_claims c JOIN agent_sessions s ON s.id=c.session_id AND s.org_id=c.org_id
    WHERE c.org_id=p_org AND s.agent_id=p_agent AND c.claim_type='chat' AND c.status='claimed';
  RETURN active < LEAST(COALESCE(configured, p_capacity-1), p_capacity-1);
END $$;

CREATE FUNCTION refresh_chat_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_claims SET last_activity_at=now()
    WHERE id=NEW.claim_id AND org_id=NEW.org_id AND claim_type='chat' AND status IN ('pending','claimed');
  RETURN NEW;
END $$;
CREATE TRIGGER chat_event_activity AFTER INSERT ON agent_claim_events
  FOR EACH ROW EXECUTE FUNCTION refresh_chat_activity();
CREATE TRIGGER chat_command_queued_activity AFTER INSERT ON agent_claim_commands
  FOR EACH ROW EXECUTE FUNCTION refresh_chat_activity();
CREATE TRIGGER chat_command_ack_activity AFTER UPDATE OF status ON agent_claim_commands
  FOR EACH ROW WHEN (NEW.status='acked' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION refresh_chat_activity();
CREATE TRIGGER chat_request_answer_activity AFTER UPDATE OF status ON agent_claim_requests
  FOR EACH ROW WHEN (NEW.status='resolved' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION refresh_chat_activity();

