-- packages/db/src/migrations/0011_verification_results_manifest.sql
ALTER TABLE verification_results ADD COLUMN IF NOT EXISTS manifest jsonb;
