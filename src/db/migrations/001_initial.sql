CREATE TABLE IF NOT EXISTS state_transitions (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_detail TEXT,
    actor TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_state_transitions_repo_issue
    ON state_transitions(repo, issue_number);

CREATE TABLE IF NOT EXISTS project_items (
    id SERIAL PRIMARY KEY,
    project_id TEXT NOT NULL,
    item_node_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    issue_number INT,
    pr_number INT,
    current_state TEXT NOT NULL DEFAULT 'Backlog',
    assignee TEXT,
    last_activity TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, item_node_id)
);

CREATE INDEX IF NOT EXISTS idx_project_items_repo
    ON project_items(repo);

CREATE TABLE IF NOT EXISTS pauses (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INT NOT NULL,
    pr_number INT,
    previous_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    context TEXT,
    checklist JSONB,
    resume_target TEXT,
    agent_id TEXT,
    paused_at TIMESTAMPTZ DEFAULT NOW(),
    resumed_at TIMESTAMPTZ,
    resumed_by TEXT,
    resume_instructions TEXT,
    resume_to_state TEXT
);

CREATE INDEX IF NOT EXISTS idx_pauses_repo_issue
    ON pauses(repo, issue_number);

CREATE TABLE IF NOT EXISTS review_retries (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    pr_number INT NOT NULL,
    retry_count INT DEFAULT 0,
    last_issues JSONB,
    last_review_sha TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(repo, pr_number)
);

CREATE TABLE IF NOT EXISTS config_cache (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL UNIQUE,
    config JSONB NOT NULL,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
