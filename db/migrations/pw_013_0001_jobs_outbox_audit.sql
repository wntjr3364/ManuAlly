-- PW-013: durable job intents, a transactional outbox, and an append-only state audit (spec 08 "신뢰 가능한 queue").
-- The job row is the source of truth for a logical command; the queue (pg-boss) only dispatches.
-- A job runs under a lease; every claim bumps a fencing token, and only the current token may finish it.

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  intent text NOT NULL CHECK (intent IN ('draft_paragraph', 'revise_selection', 'review', 'extract_facts', 'literature_search', 'export')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[!-~]{1,200}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE',
    'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text CHECK (length(last_error) <= 1000),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (paper_id, idempotency_key),
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, owner_id) REFERENCES paper_projects(id, owner_id),
  CHECK ((status = 'RUNNING') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX jobs_paper_created ON jobs (paper_id, created_at DESC);

CREATE FUNCTION pw_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: jobs are kept; cancel instead of deleting' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' OR NEW.fencing_token <> 0 OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'illegal job transition: jobs start QUEUED' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.paper_id, NEW.owner_id, NEW.intent, NEW.idempotency_key, NEW.payload, NEW.payload_hash, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.paper_id, OLD.owner_id, OLD.intent, OLD.idempotency_key, OLD.payload, OLD.payload_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable: a job''s intent and payload cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'illegal job transition: fencing token went backwards' USING ERRCODE = 'restrict_violation';
  END IF;
  ok := NEW.status = OLD.status AND (OLD.status <> 'RUNNING' OR NEW.fencing_token >= OLD.fencing_token)
     OR (OLD.status IN ('QUEUED', 'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER') AND NEW.status IN ('QUEUED', 'RUNNING', 'CANCELLED'))
     OR (OLD.status = 'RUNNING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE', 'QUEUED', 'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER'));
  IF NOT ok THEN
    RAISE EXCEPTION 'illegal job transition: % -> %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  -- finished jobs are final
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE') AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'immutable: job is finished (%)', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  -- a new run (claim) must take a new fencing token
  IF NEW.status = 'RUNNING' AND (OLD.status <> 'RUNNING' OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner) AND NEW.fencing_token <= OLD.fencing_token THEN
    RAISE EXCEPTION 'illegal job transition: a claim needs a new fencing token' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_guard BEFORE INSERT OR UPDATE OR DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION pw_job_guard();
CREATE TRIGGER jobs_no_truncate BEFORE TRUNCATE ON jobs FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

-- Transactional outbox: written in the same transaction as the job (or its retry), published later.
CREATE TABLE job_outbox (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (length(last_error) <= 1000)
);
CREATE INDEX job_outbox_pending ON job_outbox (available_at, id) WHERE published_at IS NULL;
CREATE FUNCTION pw_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: outbox rows are kept' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.job_id, NEW.payload, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.job_id, OLD.payload, OLD.created_at)
     OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'immutable: outbox message content and publication cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_outbox_guard BEFORE UPDATE OR DELETE ON job_outbox FOR EACH ROW EXECUTE FUNCTION pw_outbox_guard();
CREATE TRIGGER job_outbox_no_truncate BEFORE TRUNCATE ON job_outbox FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

-- Append-only audit of state changes, written by triggers inside the changing transaction.
-- actor comes from the transaction setting pw.actor (owner:<id> / worker:<id>); without it the
-- change came from outside the application and is recorded as db:<role>.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  paper_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  from_state text,
  to_state text,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_events_entity ON audit_events (entity_id, id);
CREATE INDEX audit_events_paper ON audit_events (paper_id, id);
SELECT pw_make_immutable('audit_events');

CREATE FUNCTION pw_audit_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entity text := TG_ARGV[0];
  state_col text := TG_ARGV[1];
  n jsonb := to_jsonb(NEW);
  o jsonb;
  actor text := coalesce(nullif(current_setting('pw.actor', true), ''), 'db:' || current_user);
  details jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_events (paper_id, entity_type, entity_id, action, from_state, to_state, actor)
      VALUES (NEW.paper_id, entity, NEW.id, 'created', NULL, n->>state_col, actor);
    RETURN NULL;
  END IF;
  o := to_jsonb(OLD);
  IF entity = 'job' AND n->'fencing_token' IS DISTINCT FROM o->'fencing_token' THEN
    details := jsonb_build_object('fencing_token', n->'fencing_token', 'lease_owner', n->'lease_owner');
  END IF;
  IF n->>state_col IS DISTINCT FROM o->>state_col OR details <> '{}'::jsonb THEN
    INSERT INTO audit_events (paper_id, entity_type, entity_id, action, from_state, to_state, actor, details)
      VALUES (NEW.paper_id, entity, NEW.id, CASE WHEN n->>state_col IS DISTINCT FROM o->>state_col THEN 'state_changed' ELSE 'reclaimed' END,
              o->>state_col, n->>state_col, actor, details);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jobs_audit AFTER INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION pw_audit_state('job', 'status');
CREATE TRIGGER story_revisions_audit AFTER INSERT OR UPDATE ON story_revisions FOR EACH ROW EXECUTE FUNCTION pw_audit_state('story_revision', 'status');
CREATE TRIGGER outline_revisions_audit AFTER INSERT OR UPDATE ON outline_revisions FOR EACH ROW EXECUTE FUNCTION pw_audit_state('outline_revision', 'status');
CREATE TRIGGER evidence_records_audit AFTER INSERT OR UPDATE ON evidence_records FOR EACH ROW EXECUTE FUNCTION pw_audit_state('evidence_record', 'extraction_state');
CREATE TRIGGER fact_records_audit AFTER INSERT OR UPDATE ON fact_records FOR EACH ROW EXECUTE FUNCTION pw_audit_state('fact_record', 'verification_state');
CREATE TRIGGER claims_audit AFTER INSERT OR UPDATE ON claims FOR EACH ROW EXECUTE FUNCTION pw_audit_state('claim', 'approval_state');
