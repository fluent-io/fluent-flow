ALTER TABLE collab_ideas
  ADD COLUMN conversion_claim_id integer REFERENCES agent_claims(id),
  ADD COLUMN conversion_claim_command_id integer REFERENCES agent_claim_commands(id),
  ADD CONSTRAINT collab_ideas_native_conversion CHECK (
    (conversion_claim_id IS NULL AND conversion_claim_command_id IS NULL)
    OR (conversion_claim_id IS NOT NULL AND conversion_claim_command_id IS NOT NULL
      AND status='converted' AND conversion_target_task_id IS NULL
      AND conversion_command_id IS NULL AND conversion_session_id IS NULL)
  );

CREATE UNIQUE INDEX collab_ideas_native_conversion_command
  ON collab_ideas(conversion_claim_command_id) WHERE conversion_claim_command_id IS NOT NULL;

CREATE FUNCTION enforce_native_idea_conversion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.conversion_claim_id IS NOT NULL
    AND (NEW.conversion_claim_id,NEW.conversion_claim_command_id)
      IS DISTINCT FROM (OLD.conversion_claim_id,OLD.conversion_claim_command_id) THEN
    RAISE EXCEPTION 'Native idea conversion is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.conversion_claim_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_claim_commands command
    JOIN agent_claims claim ON claim.id=command.claim_id AND claim.org_id=command.org_id
    JOIN collab_claim_executions execution ON execution.claim_id=claim.id
    WHERE command.id=NEW.conversion_claim_command_id AND claim.id=NEW.conversion_claim_id
      AND command.kind='prompt' AND claim.claim_type='chat'
      AND execution.task_id=NEW.task_id AND execution.project_id=NEW.project_id
  ) THEN
    RAISE EXCEPTION 'Invalid native idea conversion' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_ideas_native_conversion_source BEFORE INSERT OR UPDATE ON collab_ideas
  FOR EACH ROW EXECUTE FUNCTION enforce_native_idea_conversion();
