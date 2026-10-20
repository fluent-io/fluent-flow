-- A4 workpad retained features (B-owned slice 2): versioned agent plan
-- snapshots and human-resolved open questions (Flowly WORKPAD-SPEC §2.2/§6).
-- Additive only; same ownership chains as 0014.

-- Append-only plan snapshots: an agent session's todo list at turn end
-- (provenance 'agent'), or a human edit (provenance 'human'). Latest row wins.
CREATE TABLE collab_workpad_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  run_id uuid REFERENCES collab_runs (id),
  session_id uuid REFERENCES collab_sessions (id),
  items jsonb NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('agent', 'human')),
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_workpad_plans_task_idx ON collab_workpad_plans (task_id, created_at DESC);

-- Open questions (agent confusions or human clarifications) resolved by a
-- human; state changes are versioned with actor history.
CREATE TABLE collab_open_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  run_id uuid REFERENCES collab_runs (id),
  session_id uuid REFERENCES collab_sessions (id),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  answer text CHECK (char_length(answer) <= 4000),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'dismissed')),
  provenance text NOT NULL CHECK (provenance IN ('agent', 'human')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  asked_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  resolved_by_principal_id uuid REFERENCES collab_principals (id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_open_questions_task_idx ON collab_open_questions (task_id, created_at DESC);

CREATE TABLE collab_open_question_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES collab_open_questions (id),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  actor_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  answer text,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_open_question_events_question_idx ON collab_open_question_events (question_id, created_at);
