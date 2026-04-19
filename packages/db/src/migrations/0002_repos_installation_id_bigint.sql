-- Widen repos.installation_id from INTEGER to BIGINT to match
-- provider_installations.id (BIGINT). GitHub installation IDs can grow
-- beyond int32; keeping the FK-candidate column as INTEGER risks
-- insert/update overflow once IDs exceed 2,147,483,647.
--
-- Safe widening: existing rows (currently small values) fit without
-- modification. Postgres rewrites the table in-place for this conversion.
ALTER TABLE "repos" ALTER COLUMN "installation_id" TYPE bigint;
