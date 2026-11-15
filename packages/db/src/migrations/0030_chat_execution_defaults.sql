ALTER TABLE collab_projects ADD COLUMN chat_execution_defaults jsonb NOT NULL DEFAULT '{"profileId":null,"model":null,"instructions":""}'::jsonb;
