ALTER TABLE collab_workspaces RENAME COLUMN legacy_org_id TO org_id;
--> statement-breakpoint
ALTER TABLE collab_principals RENAME COLUMN legacy_user_id TO user_id;
--> statement-breakpoint
ALTER INDEX collab_principals_legacy_user_id_idx RENAME TO collab_principals_user_id_idx;
