-- Track whether an agent has acknowledged a resume notification
ALTER TABLE pauses ADD COLUMN IF NOT EXISTS resume_acknowledged_at TIMESTAMPTZ;
