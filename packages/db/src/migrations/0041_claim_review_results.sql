CREATE TABLE collab_claim_review_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporting_binding_id uuid NOT NULL UNIQUE REFERENCES collab_scoped_tokens(id),
  head_sha text NOT NULL CHECK (head_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  result_json text NOT NULL CHECK (octet_length(result_json) <= 60000 AND jsonb_typeof(result_json::jsonb) = 'object'),
  result_hash text NOT NULL CHECK (result_hash = encode(sha256(convert_to(result_json, 'UTF8')), 'hex')),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  github_review_node_id text,
  child_claim_id bigint REFERENCES agent_claims(id),
  retry_count_after integer CHECK (retry_count_after >= 0),
  CHECK ((applied_at IS NULL AND github_review_node_id IS NULL AND child_claim_id IS NULL AND retry_count_after IS NULL)
    OR (applied_at IS NOT NULL AND github_review_node_id IS NOT NULL AND length(github_review_node_id) BETWEEN 1 AND 200 AND retry_count_after IS NOT NULL))
);

CREATE FUNCTION enforce_claim_review_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.reporting_binding_id, NEW.head_sha, NEW.result_json, NEW.result_hash, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.reporting_binding_id, OLD.head_sha, OLD.result_json, OLD.result_hash, OLD.created_at)
      OR (OLD.applied_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Review publication is immutable';
    END IF;
    IF NEW.child_claim_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM collab_scoped_tokens binding JOIN collab_claim_executions child ON child.parent_claim_id=binding.claim_id
      WHERE binding.id=NEW.reporting_binding_id AND child.claim_id=NEW.child_claim_id
    ) THEN
      RAISE EXCEPTION 'Review child identity mismatch';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM collab_scoped_tokens binding JOIN agent_claims claim ON claim.id=binding.claim_id
    JOIN collab_claim_executions execution ON execution.claim_id=claim.id
    WHERE binding.id=NEW.reporting_binding_id AND binding.claimed_at=claim.claimed_at
      AND binding.runner_session_id=claim.session_id AND claim.status='claimed' AND claim.expires_at>now()
      AND claim.claim_type='review' AND claim.head_sha=NEW.head_sha AND execution.delivery_link_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Review publication identity mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collab_claim_review_results_identity BEFORE INSERT OR UPDATE ON collab_claim_review_results
FOR EACH ROW EXECUTE FUNCTION enforce_claim_review_result();
