-- Durable execution queue and host protocol (A3). Additive-only; new tables
-- reference live/new tables one-sided per contract.

-- Execution hosts (PC-side connectors). Token stored hashed only.
CREATE TABLE collab_hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  token_hash text NOT NULL UNIQUE,
  enrolled_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  revoked_at timestamptz,
  connector_session_id uuid,
  -- Persisted connector instance identity: same-instance re-register is
  -- idempotent; a DIFFERENT instance on an unexpired session is rejected.
  connector_instance_id text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  last_heartbeat_at timestamptz,
  -- Last reported allowlist {repositories:[{key}], profiles:[…]} — never secrets.
  catalog jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Allowlisted project→host repository mappings.
CREATE TABLE collab_project_host_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  host_id uuid NOT NULL REFERENCES collab_hosts (id),
  repository_key text NOT NULL CHECK (char_length(repository_key) BETWEEN 1 AND 200),
  base_ref text NOT NULL DEFAULT 'main' CHECK (char_length(base_ref) BETWEEN 1 AND 200),
  profile_ids text[] NOT NULL DEFAULT '{}',
  default_profile_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, host_id, repository_key)
);

CREATE TABLE collab_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  -- Denormalized ownership chain: every child row carries project/task reach.
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  host_id uuid NOT NULL REFERENCES collab_hosts (id),
  mapping_id uuid NOT NULL REFERENCES collab_project_host_mappings (id),
  profile_id text NOT NULL CHECK (char_length(profile_id) BETWEEN 1 AND 200),
  model text,
  instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 20000),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'launching', 'running', 'needs_input', 'idle', 'failed',
                     'cancel_requested', 'cancelled', 'reconciling')),
  stage text NOT NULL DEFAULT 'design'
    CHECK (stage IN ('design', 'development', 'test', 'in_review')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  workspace_id text,
  last_observed_at timestamptz,
  head_commit text,
  retry_of_run_id uuid REFERENCES collab_runs (id),
  error_code text,
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_runs_task_idx ON collab_runs (task_id, created_at);
-- One unresolved active run per task (contract); multiple sessions live inside it.
CREATE UNIQUE INDEX collab_runs_one_active_per_task
  ON collab_runs (task_id)
  WHERE state IN ('queued', 'launching', 'running', 'needs_input', 'cancel_requested', 'reconciling');

CREATE TABLE collab_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES collab_runs (id),
  role text NOT NULL DEFAULT 'work' CHECK (role IN ('work', 'summary')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  paseo_agent_id text,
  provider_session_id text,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'launching', 'running', 'needs_input', 'idle', 'failed',
                     'cancel_requested', 'cancelled', 'reconciling')),
  last_observed_at timestamptz,
  timeline_epoch text,
  timeline_seq text,
  capabilities jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_sessions_run_idx ON collab_sessions (run_id, created_at);

-- Durable command queue; stored BEFORE delivery to the host.
CREATE TABLE collab_connector_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES collab_hosts (id),
  run_id uuid NOT NULL REFERENCES collab_runs (id),
  session_id uuid REFERENCES collab_sessions (id),
  kind text NOT NULL CHECK (kind IN ('launch', 'create_session', 'prompt', 'permission',
                                     'cancel', 'summarize', 'artifact_read',
                                     'wrapup_preflight', 'wrapup')),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'accepted', 'applied', 'failed', 'ambiguous', 'cancelled')),
  lease_epoch bigint,
  claimed_at timestamptz,
  acked_at timestamptz,
  result jsonb,
  error_code text,
  created_by_principal_id uuid REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_connector_commands_host_idx
  ON collab_connector_commands (host_id, state, created_at);
CREATE INDEX collab_connector_commands_run_idx ON collab_connector_commands (run_id, created_at);

-- Provider observations. Idempotency source = eventId (globally unique):
-- one provider event may fan out into multiple observation kinds carrying the
-- SAME cursor (e.g. state + usage on turn completion), so (run,epoch,seq) is
-- NOT unique. High-watermarks are tracked per (run, session, epoch) instead.
CREATE TABLE collab_connector_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL UNIQUE CHECK (char_length(event_id) BETWEEN 1 AND 200),
  host_id uuid NOT NULL REFERENCES collab_hosts (id),
  run_id uuid NOT NULL REFERENCES collab_runs (id),
  session_id uuid REFERENCES collab_sessions (id),
  kind text NOT NULL CHECK (kind IN ('workspace_bound', 'session_bound', 'state', 'timeline',
                                     'attention', 'usage', 'check', 'artifact', 'idea',
                                     'summary', 'wrapup')),
  payload jsonb NOT NULL,
  provider_epoch text,
  provider_seq text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_connector_observations_run_idx
  ON collab_connector_observations (run_id, session_id, provider_epoch, provider_seq);

-- Canonical request idempotency for mutation POSTs (runs, sessions, commands).
CREATE TABLE collab_idempotency_records (
  principal_id uuid NOT NULL REFERENCES collab_principals (id),
  scope_key text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  request_hash text NOT NULL,
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, scope_key, idempotency_key)
);

-- Scoped API tokens (collaboration MCP; run-scoped agent credentials).
-- Reporting credentials are minted per session at run start and bound to
-- exactly one project/run(/session); capabilities are a fixed reporting
-- subset — never membership/start/accept/human provenance. Raw token is only
-- ever in the authorized command delivery; at rest: hash + short prefix.
CREATE TABLE collab_scoped_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES collab_principals (id),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL DEFAULT '' CHECK (char_length(token_prefix) <= 12),
  scopes text[] NOT NULL DEFAULT '{}',
  project_id uuid REFERENCES collab_projects (id),
  run_id uuid REFERENCES collab_runs (id),
  session_id uuid REFERENCES collab_sessions (id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One reporting credential per session (upsert target).
  UNIQUE (session_id)
);

-- Reporting capabilities are fixed; enforce the vocabulary (array subset).
ALTER TABLE collab_scoped_tokens
  ADD CONSTRAINT collab_scoped_tokens_caps_check
  CHECK (
    scopes <> '{}'
    AND scopes <@ ARRAY[
      'report.check', 'report.artifact', 'report.idea',
      'report.progress', 'report.summary'
    ]::text[]
  );
