-- New, unshipped collaboration schema only; preserve legacy tables unchanged.
ALTER TABLE collab_runs ADD COLUMN dirty boolean;
ALTER TABLE collab_runs ADD COLUMN progress jsonb;

CREATE TABLE collab_project_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES collab_principals(id),
  project_id uuid NOT NULL REFERENCES collab_projects(id),
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL CHECK(char_length(token_prefix)<=12),
  session_version integer NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collab_project_tokens_principal ON collab_project_tokens(principal_id,project_id);

CREATE TABLE collab_delivery_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES collab_tasks(id),
  project_id uuid NOT NULL REFERENCES collab_projects(id),
  repo text NOT NULL,
  pr_number integer CHECK(pr_number>0),
  claim_id text,
  created_by_principal_id uuid NOT NULL REFERENCES collab_principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(pr_number IS NOT NULL OR claim_id IS NOT NULL)
);
CREATE INDEX collab_delivery_links_task ON collab_delivery_links(task_id,created_at);
