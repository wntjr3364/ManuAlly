-- PW-013 re-review m4: a run starts only from QUEUED (or takes over an expired RUNNING lease);
-- attempts and fencing token change only on a claim, and then by exactly one.
CREATE OR REPLACE FUNCTION pw_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok boolean;
  claim boolean;
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
  claim := NEW.status = 'RUNNING' AND (OLD.status <> 'RUNNING' OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.fencing_token <> OLD.fencing_token);
  IF claim THEN
    IF OLD.status NOT IN ('QUEUED', 'RUNNING') OR NEW.fencing_token <> OLD.fencing_token + 1 OR NEW.attempts <> OLD.attempts + 1 THEN
      RAISE EXCEPTION 'illegal job transition: a claim starts from QUEUED (or an expired run) with token+1 and attempts+1' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.fencing_token <> OLD.fencing_token OR NEW.attempts <> OLD.attempts THEN
    RAISE EXCEPTION 'illegal job transition: attempts and fencing token change only on a claim' USING ERRCODE = 'restrict_violation';
  END IF;
  ok := claim
     OR (OLD.status IN ('QUEUED', 'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER') AND NEW.status IN ('QUEUED', 'CANCELLED', 'FAILED'))
     OR (OLD.status = 'RUNNING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE', 'QUEUED', 'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER'))
     OR (OLD.status = 'RUNNING' AND NEW.status = 'RUNNING');
  IF NOT ok OR (OLD.status = NEW.status AND OLD.status <> 'RUNNING' AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'illegal job transition: % -> %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'RUNNING' AND NOT claim AND (to_jsonb(NEW) - ARRAY['updated_at', 'lease_expires_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'lease_expires_at']) THEN
    RAISE EXCEPTION 'illegal job transition: during a run only the lease deadline may change' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
