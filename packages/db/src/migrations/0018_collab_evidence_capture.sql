-- Forward-only capture metadata on new, unshipped collaboration evidence.
-- NULL means the source did not report worktree cleanliness; never infer clean.
ALTER TABLE collab_check_evidence ADD COLUMN dirty boolean;
