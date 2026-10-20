-- A4 evidence schema (B-owned slice). Additive only; every child row carries
-- project/task reach through enforced FK chains. References A's 0012/0013
-- tables (collab_tasks, collab_runs, collab_sessions).

-- Acceptance criteria with versioned state; history is append-only.
CREATE TABLE collab_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'met', 'waived')),
  reason text CHECK (char_length(reason) <= 2000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_criteria_task_idx ON collab_criteria (task_id, created_at);

CREATE TABLE collab_criteria_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_id uuid NOT NULL REFERENCES collab_criteria (id),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  actor_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  reason text,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_criteria_events_criterion_idx ON collab_criteria_events (criterion_id, created_at);

-- Named checks (exact commands) and append-only evidence.
CREATE TABLE collab_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  command text NOT NULL CHECK (char_length(command) BETWEEN 1 AND 4000),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('client', 'internal')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, name)
);

CREATE TABLE collab_check_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES collab_checks (id),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  run_id uuid REFERENCES collab_runs (id),
  session_id uuid REFERENCES collab_sessions (id),
  commit_sha text,
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'not_run')),
  exit_code integer,
  observed_at timestamptz NOT NULL DEFAULT now(),
  output_artifact_id uuid,
  -- human = recorded by a principal; agent = agent-reported claim;
  -- runner = observed command exit. Agent claims are visibly agent-reported.
  provenance text NOT NULL CHECK (provenance IN ('human', 'agent', 'runner')),
  actor_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  check_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_check_evidence_check_idx ON collab_check_evidence (check_id, observed_at DESC);
-- Agent-reported and runner evidence must reference a known run/session so
-- observations cannot attach foreign results to a task.
ALTER TABLE collab_check_evidence
  ADD CONSTRAINT collab_check_evidence_provenance_bounds
  CHECK (
    (provenance = 'human') OR
    (provenance IN ('agent', 'runner') AND run_id IS NOT NULL)
  );

-- Input/output artifact references with ownership and visibility.
CREATE TABLE collab_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  run_id uuid REFERENCES collab_runs (id),
  session_id uuid REFERENCES collab_sessions (id),
  direction text NOT NULL CHECK (direction IN ('input', 'output')),
  kind text NOT NULL CHECK (kind IN ('file', 'url', 'text')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 and 300),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('client', 'internal')),
  provenance text NOT NULL CHECK (provenance IN ('human', 'agent', 'runner')),
  owner_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  media_type text,
  size_bytes bigint,
  sha256 text,
  -- file: mapping/workspace-relative opaque id (never client paths);
  -- url: absolute URL; text: inline bounded content.
  reference text,
  content text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  superseded_by_artifact_id uuid REFERENCES collab_artifacts (id),
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'text' OR char_length(content) <= 2000000)
);

CREATE INDEX collab_artifacts_task_idx ON collab_artifacts (task_id, created_at);

-- Source-linked follow-up ideas; conversion is idempotent per idempotency key.
CREATE TABLE collab_ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  run_id uuid REFERENCES collab_runs (id),
  session_id uuid REFERENCES collab_sessions (id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  body text NOT NULL CHECK (char_length(body) <= 20000),
  status text NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'converted', 'dismissed')),
  conversion_target_task_id uuid REFERENCES collab_tasks (id),
  conversion_command_id uuid,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('client', 'internal')),
  author_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, idempotency_key)
);

CREATE INDEX collab_ideas_task_idx ON collab_ideas (task_id, created_at);

-- Versioned run summaries; generation is explicit and configurable/disabled
-- upstream, never automatic.
CREATE TABLE collab_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES collab_runs (id),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  session_id uuid REFERENCES collab_sessions (id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 100000),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('client', 'internal')),
  model text,
  source_epoch text,
  source_seq text,
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_summaries_run_idx ON collab_summaries (run_id, created_at DESC);

-- Provider usage samples; dedupe by session + provider turn identity so
-- cumulative snapshots never double-count. Unavailable usage is a reason row.
CREATE TABLE collab_usage_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES collab_runs (id),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  -- Sentinel session for whole-run samples: NULLs never collide in unique
  -- indexes, so dedupe needs a concrete value (zero uuid = 'no session'). No
  -- FK here (the sentinel has no session row); real session ids are validated
  -- against the run's task at the service layer.
  session_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  provider_turn_id text NOT NULL,
  tokens_in bigint CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out bigint CHECK (tokens_out IS NULL OR tokens_out >= 0),
  cost_usd numeric(12, 6),
  unavailable_reason text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, provider_turn_id)
);

CREATE INDEX collab_usage_samples_project_idx ON collab_usage_samples (project_id, observed_at);

-- Delivery snapshots and human decisions; acceptance requires acknowledging
-- the open-item ids captured at that delivery version.
CREATE TABLE collab_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  note text NOT NULL CHECK (char_length(note) <= 20000),
  artifact_ids uuid[] NOT NULL DEFAULT '{}',
  check_evidence_ids uuid[] NOT NULL DEFAULT '{}',
  open_item_ids uuid[] NOT NULL DEFAULT '{}',
  task_version integer NOT NULL,
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_deliveries_task_idx ON collab_deliveries (task_id, created_at DESC);

CREATE TABLE collab_task_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  decision text NOT NULL CHECK (decision IN ('accept', 'cancel', 'reopen')),
  note text CHECK (char_length(note) <= 20000),
  acknowledged_open_item_ids uuid[] NOT NULL DEFAULT '{}',
  delivery_id uuid REFERENCES collab_deliveries (id),
  task_version integer NOT NULL,
  decided_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_task_decisions_task_idx ON collab_task_decisions (task_id, created_at DESC);
