ALTER TABLE collab_claim_workspace_state
  ADD COLUMN repository text,
  ADD COLUMN task_branch text,
  ADD COLUMN task_branch_head text,
  ADD CONSTRAINT collab_claim_workspace_remote CHECK (
    (repository IS NULL OR repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
    AND ((task_branch IS NULL AND task_branch_head IS NULL)
      OR (task_branch IS NOT NULL AND task_branch_head IS NOT NULL AND char_length(task_branch) BETWEEN 1 AND 1024 AND task_branch_head ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'))
    AND (state='known' OR (repository IS NULL AND task_branch IS NULL AND task_branch_head IS NULL))
  );

ALTER TABLE collab_delivery_links
  ADD COLUMN org_id text REFERENCES orgs(id),
  ADD COLUMN root_claim_id integer REFERENCES agent_claims(id),
  ADD COLUMN native_binding_id uuid REFERENCES collab_scoped_tokens(id),
  ADD COLUMN producer_binding_id uuid REFERENCES collab_scoped_tokens(id),
  ADD COLUMN github_pr_node_id text,
  ADD COLUMN head_branch text,
  ADD COLUMN head_sha text,
  ADD CONSTRAINT collab_delivery_links_native CHECK (
    (org_id IS NULL AND root_claim_id IS NULL AND native_binding_id IS NULL AND producer_binding_id IS NULL AND github_pr_node_id IS NULL AND head_branch IS NULL AND head_sha IS NULL)
    OR (org_id IS NOT NULL AND root_claim_id IS NOT NULL AND native_binding_id IS NOT NULL AND producer_binding_id IS NOT NULL
      AND pr_number IS NOT NULL AND claim_id IS NOT NULL AND github_pr_node_id IS NOT NULL
      AND head_branch IS NOT NULL AND head_sha IS NOT NULL AND char_length(head_branch) BETWEEN 1 AND 1024 AND head_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$')
  );
CREATE UNIQUE INDEX collab_delivery_links_native_pr ON collab_delivery_links(org_id,repo,pr_number) WHERE native_binding_id IS NOT NULL;
CREATE UNIQUE INDEX collab_delivery_links_native_root ON collab_delivery_links(org_id,root_claim_id) WHERE native_binding_id IS NOT NULL;

CREATE TABLE collab_pull_request_roots (
  root_claim_id integer PRIMARY KEY REFERENCES agent_claims(id),
  delivery_link_id uuid NOT NULL REFERENCES collab_delivery_links(id),
  producer_claim_id integer NOT NULL REFERENCES agent_claims(id),
  UNIQUE(root_claim_id,delivery_link_id)
);

CREATE TABLE collab_pull_request_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  repo text NOT NULL,
  pr_number integer NOT NULL CHECK(pr_number>0),
  github_pr_node_id text NOT NULL,
  head_branch text NOT NULL CHECK(char_length(head_branch) BETWEEN 1 AND 1024),
  head_sha text NOT NULL CHECK(head_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  delivery_link_id uuid REFERENCES collab_delivery_links(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,repo,pr_number)
);
CREATE TABLE collab_claim_pr_reservations (
  claim_id integer PRIMARY KEY REFERENCES agent_claims(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES collab_pull_request_candidates(id),
  producer_binding_id uuid REFERENCES collab_scoped_tokens(id),
  task_id uuid REFERENCES collab_tasks(id),
  root_claim_id integer REFERENCES agent_claims(id),
  github_check_id bigint,
  head_sha text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collab_claim_pr_reservation_source CHECK (
    (producer_binding_id IS NULL AND task_id IS NULL AND root_claim_id IS NULL AND github_check_id IS NULL AND head_sha IS NULL)
    OR (producer_binding_id IS NOT NULL AND task_id IS NOT NULL AND root_claim_id IS NOT NULL
      AND head_sha IS NOT NULL AND head_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      AND (github_check_id IS NULL OR github_check_id>0))
  )
);

CREATE FUNCTION enforce_claim_pr_reservation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.producer_binding_id IS DISTINCT FROM OLD.producer_binding_id
    OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.root_claim_id IS DISTINCT FROM OLD.root_claim_id OR NEW.github_check_id IS DISTINCT FROM OLD.github_check_id)
  THEN RAISE EXCEPTION 'Reservation source is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.producer_binding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM collab_scoped_tokens token
    JOIN agent_claims source ON source.id=token.claim_id
    JOIN collab_claim_executions execution ON execution.claim_id=token.claim_id
    JOIN collab_pull_request_candidates candidate ON candidate.id=NEW.candidate_id
    WHERE token.id=NEW.producer_binding_id AND token.revoked_at IS NULL AND token.task_id=NEW.task_id
      AND source.claim_type IN ('build','review_fix')
      AND source.org_id=candidate.org_id AND source.repo=candidate.repo
      AND execution.task_id=token.task_id AND execution.project_id=token.project_id
      AND execution.root_claim_id=NEW.root_claim_id
      AND execution.created_by_principal_id=token.principal_id
      AND execution.created_by_session_version=token.creator_session_version
  ) THEN RAISE EXCEPTION 'Invalid native PR reservation source' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_claim_pr_reservations_source BEFORE INSERT OR UPDATE ON collab_claim_pr_reservations
  FOR EACH ROW EXECUTE FUNCTION enforce_claim_pr_reservation_source();
ALTER TABLE collab_claim_executions
  ADD COLUMN parent_claim_id integer REFERENCES agent_claims(id),
  ADD COLUMN delivery_link_id uuid REFERENCES collab_delivery_links(id),
  ADD CONSTRAINT collab_claim_execution_distinct_parent CHECK(parent_claim_id IS DISTINCT FROM claim_id);
ALTER TABLE collab_claim_executions ADD CONSTRAINT collab_claim_execution_pr_root
  FOREIGN KEY(root_claim_id,delivery_link_id) REFERENCES collab_pull_request_roots(root_claim_id,delivery_link_id);

CREATE FUNCTION enforce_native_pull_request_root() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.root_claim_id IS DISTINCT FROM OLD.root_claim_id
    OR NEW.delivery_link_id IS DISTINCT FROM OLD.delivery_link_id OR NEW.producer_claim_id IS DISTINCT FROM OLD.producer_claim_id)
  THEN RAISE EXCEPTION 'Native PR root is immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM collab_delivery_links link JOIN collab_claim_executions execution ON execution.claim_id=NEW.producer_claim_id
    JOIN agent_claims claim ON claim.id=execution.claim_id
    WHERE link.id=NEW.delivery_link_id AND link.native_binding_id IS NOT NULL
      AND execution.root_claim_id=NEW.root_claim_id AND execution.task_id=link.task_id AND execution.project_id=link.project_id
      AND claim.claim_type='build' AND claim.org_id=link.org_id AND claim.repo=link.repo
  ) THEN RAISE EXCEPTION 'Invalid native PR root' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_pull_request_roots_identity BEFORE INSERT OR UPDATE ON collab_pull_request_roots
  FOR EACH ROW EXECUTE FUNCTION enforce_native_pull_request_root();

CREATE FUNCTION enforce_native_pull_request_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.native_binding_id IS NOT NULL AND (
    NEW.native_binding_id IS DISTINCT FROM OLD.native_binding_id OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.repo IS DISTINCT FROM OLD.repo OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
    OR NEW.github_pr_node_id IS DISTINCT FROM OLD.github_pr_node_id OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
  ) THEN RAISE EXCEPTION 'Native PR identity is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.native_binding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM collab_scoped_tokens origin_token
    JOIN agent_claims origin_claim ON origin_claim.id=origin_token.claim_id
    JOIN collab_claim_executions origin_execution ON origin_execution.claim_id=origin_claim.id
    JOIN collab_scoped_tokens producer_token ON producer_token.id=NEW.producer_binding_id
    JOIN agent_claims producer_claim ON producer_claim.id=producer_token.claim_id
    JOIN collab_claim_executions producer_execution ON producer_execution.claim_id=producer_claim.id
    WHERE origin_token.id=NEW.native_binding_id AND origin_claim.claim_type='build'
      AND NEW.org_id=origin_claim.org_id AND NEW.repo=origin_claim.repo AND NEW.claim_id=origin_claim.id::text
      AND NEW.task_id=origin_token.task_id AND NEW.project_id=origin_token.project_id
      AND NEW.root_claim_id=origin_execution.root_claim_id
      AND NEW.created_by_principal_id=origin_token.principal_id
      AND producer_claim.claim_type IN ('build','review_fix') AND producer_claim.org_id=NEW.org_id AND producer_claim.repo=NEW.repo
      AND producer_token.task_id=NEW.task_id AND producer_token.project_id=NEW.project_id
      AND (producer_token.id=origin_token.id OR EXISTS (
        SELECT 1 FROM collab_pull_request_roots root WHERE root.root_claim_id=producer_execution.root_claim_id AND root.delivery_link_id=NEW.id))
      AND NOT EXISTS (SELECT 1 FROM collab_pull_request_roots root WHERE root.root_claim_id=NEW.root_claim_id AND root.delivery_link_id<>NEW.id)
  ) THEN RAISE EXCEPTION 'Invalid native PR source' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_delivery_links_native_identity BEFORE INSERT OR UPDATE ON collab_delivery_links
  FOR EACH ROW EXECUTE FUNCTION enforce_native_pull_request_link();

CREATE FUNCTION enforce_native_claim_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_claim_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM collab_claim_executions parent
    WHERE parent.claim_id=NEW.parent_claim_id AND parent.task_id=NEW.task_id AND parent.project_id=NEW.project_id
      AND parent.root_claim_id=NEW.root_claim_id AND parent.created_by_principal_id=NEW.created_by_principal_id
      AND parent.created_by_session_version IS NOT DISTINCT FROM NEW.created_by_session_version
  ) THEN RAISE EXCEPTION 'Invalid native claim parent' USING ERRCODE='23514'; END IF;
  IF NEW.delivery_link_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM collab_delivery_links link
    JOIN collab_pull_request_roots root ON root.delivery_link_id=link.id AND root.root_claim_id=NEW.root_claim_id
    JOIN collab_claim_executions origin ON origin.claim_id=root.producer_claim_id
    JOIN agent_claims claim ON claim.id=NEW.claim_id
    WHERE link.id=NEW.delivery_link_id AND link.task_id=NEW.task_id AND link.project_id=NEW.project_id
      AND origin.root_claim_id=NEW.root_claim_id AND origin.created_by_principal_id=NEW.created_by_principal_id
      AND origin.created_by_session_version IS NOT DISTINCT FROM NEW.created_by_session_version
      AND claim.org_id=link.org_id AND claim.repo=link.repo AND claim.pr_number=link.pr_number
  ) THEN RAISE EXCEPTION 'Invalid native PR claim source' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collab_claim_executions_native_parent BEFORE INSERT OR UPDATE OF parent_claim_id,delivery_link_id ON collab_claim_executions
  FOR EACH ROW EXECUTE FUNCTION enforce_native_claim_parent();
