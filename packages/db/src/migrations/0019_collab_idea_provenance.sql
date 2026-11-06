-- Forward-only metadata on new, unshipped collaboration resources.
ALTER TABLE collab_ideas
  ADD COLUMN provenance text NOT NULL DEFAULT 'human' CHECK (provenance IN ('human','agent','runner')),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD CONSTRAINT collab_ideas_conversion_command_fk FOREIGN KEY (conversion_command_id) REFERENCES collab_connector_commands(id),
  ADD COLUMN conversion_session_id uuid REFERENCES collab_sessions(id);
ALTER TABLE collab_summaries
  ADD COLUMN provenance text NOT NULL DEFAULT 'human' CHECK (provenance IN ('human','agent','runner'));
