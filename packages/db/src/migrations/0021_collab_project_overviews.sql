-- Additive project overview metadata. A project with no row reads as an empty
-- overview; existing collab_projects columns are untouched. Edits are guarded
-- by collab_projects.version (the row lock + version bump live in the service).
CREATE TABLE collab_project_overviews (
  project_id uuid PRIMARY KEY REFERENCES collab_projects (id),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 20000),
  run_instructions text NOT NULL DEFAULT '' CHECK (char_length(run_instructions) <= 20000),
  test_instructions text NOT NULL DEFAULT '' CHECK (char_length(test_instructions) <= 20000),
  updated_by_principal_id uuid REFERENCES collab_principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
