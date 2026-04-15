-- 016_repos_add_installation_id.sql

ALTER TABLE repos ADD COLUMN IF NOT EXISTS installation_id INTEGER REFERENCES provider_installations(id);
