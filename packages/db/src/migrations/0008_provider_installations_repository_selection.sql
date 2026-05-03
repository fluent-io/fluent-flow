-- Add repository_selection column to provider_installations.
-- Values: 'all' or 'selected'. Nullable for backwards compatibility
-- (existing rows have no value until the next installation event).
ALTER TABLE provider_installations
  ADD COLUMN IF NOT EXISTS repository_selection TEXT;

COMMENT ON COLUMN provider_installations.repository_selection IS
  'GitHub repository_selection: ''all'' (all repos) or ''selected'' (specific repos). Nullable for pre-existing rows.';
