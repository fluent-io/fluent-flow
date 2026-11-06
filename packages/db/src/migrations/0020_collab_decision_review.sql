-- Additive audit metadata on the new, unshipped collaboration schema.
-- Existing decisions remain NULL: their reviewed evidence is not reconstructed.
ALTER TABLE collab_task_decisions
  ADD COLUMN review_snapshot jsonb,
  ADD CONSTRAINT collab_task_decisions_review_snapshot_check
    CHECK (review_snapshot IS NULL OR
      (decision = 'accept' AND jsonb_typeof(review_snapshot) = 'object'));

COMMENT ON COLUMN collab_task_decisions.review_snapshot IS
  'Server-validated review captured at acceptance; NULL for earlier decisions and cancel/reopen. Never recomputed from current run state.';
