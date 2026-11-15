CREATE TABLE collab_execution_archives (
  id uuid PRIMARY KEY,
  source_run_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES collab_workspaces(id),
  org_id text,
  project_id uuid NOT NULL REFERENCES collab_projects(id),
  task_id uuid NOT NULL REFERENCES collab_tasks(id),
  format_version integer NOT NULL CHECK (format_version = 1),
  captured_at timestamptz NOT NULL,
  source_state text NOT NULL,
  source_stage text NOT NULL,
  source_created_at timestamptz NOT NULL,
  record_counts jsonb NOT NULL CHECK (jsonb_typeof(record_counts) = 'object'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz
);

CREATE INDEX collab_execution_archives_source_idx
  ON collab_execution_archives(workspace_id, source_run_id, captured_at DESC, id DESC);
CREATE UNIQUE INDEX collab_execution_archives_sealed_idx
  ON collab_execution_archives(source_run_id) WHERE sealed_at IS NOT NULL;

CREATE TABLE collab_execution_archive_records (
  archive_id uuid NOT NULL REFERENCES collab_execution_archives(id) DEFERRABLE INITIALLY DEFERRED,
  record_type text NOT NULL CHECK (record_type IN ('command','observation','run','session')),
  record_id uuid NOT NULL,
  session_id uuid,
  source_created_at timestamptz NOT NULL,
  event_kind text,
  payload_json text NOT NULL CHECK (jsonb_typeof(payload_json::jsonb) = 'object'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (archive_id, record_type, record_id)
);

CREATE INDEX collab_execution_archive_timeline_idx
  ON collab_execution_archive_records(archive_id, session_id, source_created_at, record_id)
  WHERE record_type = 'observation';

CREATE FUNCTION enforce_execution_archive_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM collab_tasks t
    JOIN collab_projects p ON p.id=t.project_id
    JOIN collab_workspaces w ON w.id=p.workspace_id
    WHERE t.id=NEW.task_id AND p.id=NEW.project_id AND w.id=NEW.workspace_id
      AND (w.org_id IS NOT DISTINCT FROM NEW.org_id OR NEW.org_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Invalid execution archive scope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_archive_scope BEFORE INSERT ON collab_execution_archives
  FOR EACH ROW EXECUTE FUNCTION enforce_execution_archive_scope();

CREATE FUNCTION protect_execution_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Sealed execution archive is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'sealed_at') IS DISTINCT FROM (to_jsonb(OLD)-'sealed_at') THEN
      RAISE EXCEPTION 'Execution archive manifest is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER execution_archive_immutable BEFORE UPDATE OR DELETE ON collab_execution_archives
  FOR EACH ROW EXECUTE FUNCTION protect_execution_archive();

CREATE FUNCTION protect_execution_archive_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_id uuid; next_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN prior_id=OLD.archive_id; END IF;
  IF TG_OP <> 'DELETE' THEN next_id=NEW.archive_id; END IF;
  PERFORM id FROM collab_execution_archives WHERE id IN (prior_id,next_id) ORDER BY id FOR SHARE;
  IF EXISTS (SELECT 1 FROM collab_execution_archives WHERE id IN (prior_id,next_id) AND sealed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Sealed execution archive is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_archive_record_immutable BEFORE INSERT OR UPDATE OR DELETE ON collab_execution_archive_records
  FOR EACH ROW EXECUTE FUNCTION protect_execution_archive_record();
