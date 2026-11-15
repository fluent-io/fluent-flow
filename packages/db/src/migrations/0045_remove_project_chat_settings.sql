ALTER TABLE collab_projects
  DROP COLUMN execution_mode,
  DROP COLUMN default_agent_id,
  DROP COLUMN chat_execution_defaults,
  DROP COLUMN chat_pending_ttl_seconds,
  DROP COLUMN chat_idle_timeout_seconds;
