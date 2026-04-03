-- Migration 008: test_failures table
-- Tracks test failure attempts per PR for retry/escalation logic.

CREATE TABLE IF NOT EXISTS test_failures (
  id SERIAL PRIMARY KEY,
  repo VARCHAR(255) NOT NULL,
  pr_number INT NOT NULL,
  sha VARCHAR(40),
  retry_count INT NOT NULL DEFAULT 0,
  test_output JSONB,
  work_item_id VARCHAR(255),
  last_pass_sha VARCHAR(40),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (repo, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_test_failures_repo_pr ON test_failures (repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_test_failures_created ON test_failures (created_at DESC);
