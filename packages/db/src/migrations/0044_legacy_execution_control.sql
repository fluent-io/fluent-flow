CREATE TABLE collab_legacy_execution_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  frozen_at timestamptz
);

INSERT INTO collab_legacy_execution_control (singleton) VALUES (true);
