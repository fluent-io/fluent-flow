-- Collaboration principals: additive identity layer for invited (non-GitHub)
-- collaborators and the collaboration mirror of GitHub users. Forward-only;
-- no existing table is altered. Foreign keys to live tables are new-table-side
-- only (allowed per docs/plans/2026-10-19-collaborative-contracts.md).
CREATE TABLE collab_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(display_name) <= 200),
  email text CHECK (email IS NULL OR char_length(email) <= 320),
  -- Unique link to the legacy GitHub user when this principal mirrors one.
  -- Never linked by email (contract: invitations do not merge identities).
  legacy_user_id integer UNIQUE REFERENCES users (id),
  disabled_at timestamptz,
  -- Rotated on password reset/revocation; JWTs and actor assertions carry it
  -- and stale versions are rejected server-side.
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Password login identity lookup (invited principals only; GitHub-mirrored
-- principals authenticate via OAuth and must not collide on email).
CREATE UNIQUE INDEX collab_principals_login_email_key
  ON collab_principals (lower(email))
  WHERE legacy_user_id IS NULL AND email IS NOT NULL;

CREATE INDEX collab_principals_legacy_user_id_idx
  ON collab_principals (legacy_user_id)
  WHERE legacy_user_id IS NOT NULL;
