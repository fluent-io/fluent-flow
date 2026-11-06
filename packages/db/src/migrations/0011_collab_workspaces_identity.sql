-- Collaboration workspaces, projects, roles, memberships, password
-- credentials, login rate limiting and single-use invitations. Additive-only:
-- no existing table is altered; new-table-side FKs reference live tables only.
CREATE TABLE collab_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  created_by_principal_id uuid REFERENCES collab_principals (id),
  legacy_org_id text,
  -- Idempotent bootstrap (contract: explicit admin action, replay-safe).
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collab_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES collab_workspaces (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  board_version integer NOT NULL DEFAULT 1 CHECK (board_version >= 1),
  -- ExecutionDefaults when configured; null until an internal admin sets them.
  execution_defaults jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Target for memberships' composite FK (project, workspace).
  UNIQUE (id, workspace_id)
);

CREATE INDEX collab_projects_workspace_idx ON collab_projects (workspace_id);

-- Composite unique keys let child tables bind (role|project, workspace) pairs
-- so a role/project from another workspace can never be referenced.
CREATE TABLE collab_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES collab_workspaces (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  capabilities text[] NOT NULL DEFAULT '{}',
  is_system boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id)
);

CREATE TABLE collab_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid,
  principal_id uuid NOT NULL REFERENCES collab_principals (id),
  role_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, role_id) REFERENCES collab_roles (workspace_id, id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES collab_projects (id, workspace_id)
);

-- One role per principal per scope; workspace scope (project_id IS NULL) is
-- separate from project scope.
CREATE UNIQUE INDEX collab_memberships_ws_principal_key
  ON collab_memberships (workspace_id, principal_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX collab_memberships_project_principal_key
  ON collab_memberships (workspace_id, project_id, principal_id) WHERE project_id IS NOT NULL;
CREATE INDEX collab_memberships_principal_idx ON collab_memberships (principal_id);

CREATE TABLE collab_password_credentials (
  principal_id uuid PRIMARY KEY REFERENCES collab_principals (id) ON DELETE CASCADE,
  -- scrypt with per-credential random salt (see collaboration/passwords.ts).
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sliding-window login/redemption throttle buckets (hashed keys only).
CREATE TABLE collab_rate_limit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collab_rate_limit_events_bucket_idx
  ON collab_rate_limit_events (bucket, attempted_at);

CREATE TABLE collab_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid,
  role_id uuid NOT NULL,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  -- sha256 of the one-time secret; the secret itself is only ever in the
  -- authorized API response / invite link fragment.
  token_hash text NOT NULL UNIQUE,
  invited_by_principal_id uuid NOT NULL REFERENCES collab_principals (id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_principal_id uuid REFERENCES collab_principals (id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, role_id) REFERENCES collab_roles (workspace_id, id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES collab_projects (id, workspace_id)
);

CREATE INDEX collab_invitations_email_idx ON collab_invitations (lower(email), created_at);
