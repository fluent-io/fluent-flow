-- Additive native-execution ownership side tables. A run or session with no
-- row here is legacy (v1 catalog / Paseo); existing collab_runs and
-- collab_sessions are untouched. No REFERENCES: a foreign key would add
-- triggers to existing tables, so parents are validated in the same Start
-- transaction (service layer) instead.
CREATE TABLE collab_run_execution (
  run_id uuid PRIMARY KEY,
  schema_version smallint NOT NULL CHECK (schema_version = 2),
  backend text NOT NULL CHECK (backend IN ('claude-code', 'codex', 'paseo')),
  host_id uuid NOT NULL,
  profile_id text NOT NULL,
  profile_revision text NOT NULL,
  snapshot jsonb NOT NULL,
  workspace_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collab_session_execution (
  session_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  backend text NOT NULL CHECK (backend IN ('claude-code', 'codex', 'paseo')),
  native_session_id text,
  binding_generation integer NOT NULL DEFAULT 0 CHECK (binding_generation >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collab_session_execution_run_id_idx ON collab_session_execution (run_id);
