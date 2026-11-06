-- Task discussion (A2 completion). Additive-only.
CREATE TABLE collab_task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  author_id uuid NOT NULL REFERENCES collab_principals (id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  visibility text NOT NULL CHECK (visibility IN ('client', 'internal')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_task_comments_task_idx ON collab_task_comments (task_id, created_at);

-- Per-principal read cursors for unread/attention behavior.
CREATE TABLE collab_read_cursors (
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  principal_id uuid NOT NULL REFERENCES collab_principals (id),
  last_event_id uuid,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, principal_id)
);

-- Task events (SSE feed source): domain transitions, comments, run state.
CREATE TABLE collab_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks (id),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  kind text NOT NULL CHECK (kind IN (
    'task_created', 'task_updated', 'task_moved', 'comment_added',
    'run_state', 'attention', 'delivery', 'decision'
  )),
  payload jsonb NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('client', 'internal')),
  actor_id uuid REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_task_events_task_idx ON collab_task_events (task_id, created_at);
CREATE INDEX collab_task_events_project_idx ON collab_task_events (project_id, created_at);
