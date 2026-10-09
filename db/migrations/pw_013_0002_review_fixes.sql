-- PW-013 review fixes (M1, minors 1, 7, 8).

-- Every job that becomes QUEUED gets a dispatch message in the same statement, wherever the
-- transition comes from (enqueue, retry, lease recovery, resume from WAITING_*). A retry may ask for a
-- delay through the transaction setting pw.dispatch_delay_secs.
CREATE FUNCTION pw_job_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delay double precision := coalesce(nullif(current_setting('pw.dispatch_delay_secs', true), '')::double precision, 0);
BEGIN
  IF NEW.status = 'QUEUED' AND (TG_OP = 'INSERT' OR OLD.status <> 'QUEUED') THEN
    INSERT INTO job_outbox (job_id, payload, available_at)
      VALUES (NEW.id, jsonb_build_object('job_id', NEW.id, 'paper_id', NEW.paper_id, 'intent', NEW.intent),
              clock_timestamp() + make_interval(secs => CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE least(greatest(delay, 0), 300) END));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jobs_dispatch AFTER INSERT OR UPDATE OF status ON jobs FOR EACH ROW EXECUTE FUNCTION pw_job_dispatch();

-- Tighter guard: finished jobs never change; attempts never go down; within one run only the lease
-- deadline may move (heartbeat) unless a new claim bumps the fencing token.
CREATE OR REPLACE FUNCTION pw_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: jobs are kept; cancel instead of deleting' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' OR NEW.fencing_token <> 0 OR NEW.attempts <> 0 OR NEW.result IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'illegal job transition: jobs start QUEUED' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE') THEN
    RAISE EXCEPTION 'immutable: job is finished (%)', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.paper_id, NEW.owner_id, NEW.intent, NEW.idempotency_key, NEW.payload, NEW.payload_hash, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.paper_id, OLD.owner_id, OLD.intent, OLD.idempotency_key, OLD.payload, OLD.payload_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable: a job''s intent and payload cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'illegal job transition: fencing token or attempts went backwards' USING ERRCODE = 'restrict_violation';
  END IF;
  ok := (OLD.status IN ('QUEUED', 'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER') AND NEW.status IN ('QUEUED', 'RUNNING', 'CANCELLED', 'FAILED'))
     OR (OLD.status = 'RUNNING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE', 'QUEUED', 'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER'))
     OR (OLD.status = 'RUNNING' AND NEW.status = 'RUNNING');
  IF NOT ok OR (OLD.status = NEW.status AND OLD.status <> 'RUNNING' AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'illegal job transition: % -> %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'RUNNING' AND (OLD.status <> 'RUNNING' OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.fencing_token <> OLD.fencing_token) THEN
    -- a claim: new token, one more attempt
    IF NEW.fencing_token <= OLD.fencing_token OR NEW.attempts <> OLD.attempts + 1 THEN
      RAISE EXCEPTION 'illegal job transition: a claim needs a new fencing token and counts one attempt' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.status = 'RUNNING' AND (to_jsonb(NEW) - ARRAY['updated_at', 'lease_expires_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'lease_expires_at']) THEN
    RAISE EXCEPTION 'illegal job transition: during a run only the lease deadline may change' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_finished_at_on_terminal CHECK ((status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE')) = (finished_at IS NOT NULL)),
  ADD CONSTRAINT jobs_result_only_on_success CHECK (result IS NULL OR status = 'SUCCEEDED');

-- Audit: per-node outline approvals and the paper's active story/outline pointers.
CREATE FUNCTION pw_audit_node_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events (paper_id, entity_type, entity_id, action, from_state, to_state, actor, details)
    VALUES (NEW.paper_id, 'outline_node', NEW.node_id, 'approved', NULL, 'APPROVED',
            coalesce(nullif(current_setting('pw.actor', true), ''), 'db:' || current_user),
            jsonb_build_object('outline_revision_id', NEW.outline_revision_id, 'content_hash', NEW.content_hash, 'approved_by', NEW.approved_by));
  RETURN NULL;
END $$;
CREATE TRIGGER outline_node_approvals_audit AFTER INSERT ON outline_node_approvals FOR EACH ROW EXECUTE FUNCTION pw_audit_node_approval();

CREATE FUNCTION pw_audit_active_pointers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor text := coalesce(nullif(current_setting('pw.actor', true), ''), 'db:' || current_user);
BEGIN
  IF NEW.active_story_revision_id IS DISTINCT FROM OLD.active_story_revision_id THEN
    INSERT INTO audit_events (paper_id, entity_type, entity_id, action, from_state, to_state, actor)
      VALUES (NEW.id, 'paper', NEW.id, 'active_story_changed', OLD.active_story_revision_id::text, NEW.active_story_revision_id::text, actor);
  END IF;
  IF NEW.active_outline_revision_id IS DISTINCT FROM OLD.active_outline_revision_id THEN
    INSERT INTO audit_events (paper_id, entity_type, entity_id, action, from_state, to_state, actor)
      VALUES (NEW.id, 'paper', NEW.id, 'active_outline_changed', OLD.active_outline_revision_id::text, NEW.active_outline_revision_id::text, actor);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER paper_active_pointers_audit AFTER UPDATE OF active_story_revision_id, active_outline_revision_id ON paper_projects
  FOR EACH ROW EXECUTE FUNCTION pw_audit_active_pointers();
