-- Canonical collaboration task backlog. A task exists with no PR, run, agent
-- or online worker: repository/host prerequisites resolve before execution,
-- not backlog capture (contract). Additive-only.
CREATE TABLE collab_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES collab_projects (id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 65535),
  status text NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid REFERENCES collab_principals (id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Opaque lexicographic rank within the lane; midpoint ordering + compaction.
  position text NOT NULL CHECK (char_length(position) BETWEEN 1 AND 64),
  blocked_reason text,
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collab_tasks_project_board_idx ON collab_tasks (project_id, status, position);
CREATE INDEX collab_tasks_assignee_idx ON collab_tasks (assignee_id)
  WHERE assignee_id IS NOT NULL;
