-- PW-049: waiting out a provider quota (spec 08 "Quota normalization", "자동 재개").
-- 1. The job guard also lets a quota wait hand the job to the owner (WAITING_USER), to a new login
--    (WAITING_AUTH), or end it (STALE) when its document moved meanwhile. Nothing else changes.
-- 2. auto_resume_grants: the owner's permission for one job to resume on its own after a quota wait, for at
--    most 72 hours, or its revocation. The latest row counts. Rows are never changed.
-- 3. quota_waits: one row per wait of a job: when to wake (the latest reset of every blocked bucket plus a
--    jitter, or a bounded backoff when a reset is not known), and what was decided at the wake-up. Only
--    state, reason and decided_at change, once, from waiting.
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
     -- PW-049: a quota wait hands the job to the owner, to a new login, or ends it when its document moved
     OR (OLD.status = 'WAITING_QUOTA' AND NEW.status IN ('WAITING_USER', 'WAITING_AUTH', 'STALE'))
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

CREATE TABLE auto_resume_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  job_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES owners(id),
  kind text NOT NULL CHECK (kind IN ('allow', 'revoke')),
  hours integer CHECK (hours IS NULL OR hours BETWEEN 1 AND 72),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, job_id) REFERENCES jobs(paper_id, id),
  CHECK ((kind = 'allow') = (hours IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX auto_resume_grants_job ON auto_resume_grants (job_id, created_at DESC, id DESC);
SELECT pw_make_immutable('auto_resume_grants');

CREATE TABLE quota_waits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  job_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('mock', 'claude_agent', 'codex')),
  auth_profile_id text NOT NULL CHECK (auth_profile_id ~ '^[A-Za-z0-9._-]{1,100}$'),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 6),
  wake_at timestamptz NOT NULL,
  reset_known boolean NOT NULL,
  blocking jsonb NOT NULL CHECK (jsonb_typeof(blocking) = 'array'),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'resumed', 'rescheduled', 'to_user', 'to_auth', 'stale', 'closed')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 100),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, attempt),
  FOREIGN KEY (paper_id, job_id) REFERENCES jobs(paper_id, id),
  CHECK ((state = 'waiting') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX quota_waits_one_open ON quota_waits (job_id) WHERE state = 'waiting';
CREATE INDEX quota_waits_due ON quota_waits (wake_at) WHERE state = 'waiting';
CREATE FUNCTION pw_quota_wait_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: quota waits are kept' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state <> 'waiting' OR (to_jsonb(NEW) - ARRAY['state', 'reason', 'decided_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'reason', 'decided_at']) THEN
    RAISE EXCEPTION 'immutable: a quota wait is decided once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quota_waits_guard BEFORE UPDATE OR DELETE ON quota_waits FOR EACH ROW EXECUTE FUNCTION pw_quota_wait_guard();
CREATE TRIGGER quota_waits_no_truncate BEFORE TRUNCATE ON quota_waits FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
