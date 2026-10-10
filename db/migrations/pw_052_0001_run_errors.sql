-- PW-052: classified run errors (spec 08 "오류 종류별 동작"). Each error a run met: its class, the state the
-- job went to, the owner's next step, whether it was retried, and a short detail (never a whole provider
-- message). provider_overloads: the overload errors per provider and login, for the circuit breaker.
-- Rows are never changed.
CREATE TABLE run_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  job_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  class text NOT NULL CHECK (class IN ('quota', 'auth', 'network', 'overloaded', 'budget', 'evidence_missing', 'schema', 'conflict', 'disk_full', 'invalid_request', 'unknown', 'circuit_open')),
  next_state text NOT NULL CHECK (next_state IN ('WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER', 'FAILED', 'STALE', 'RETRY')),
  action text NOT NULL CHECK (action IN ('wait_for_reset', 'log_in_again', 'set_budget', 'add_evidence', 'ask_again', 'free_disk_space', 'report', 'none')),
  retried boolean NOT NULL,
  retry_after_s integer CHECK (retry_after_s IS NULL OR retry_after_s >= 0),
  detail text NOT NULL CHECK (char_length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, job_id) REFERENCES jobs(paper_id, id)
);
CREATE INDEX run_errors_job ON run_errors (job_id, created_at);
SELECT pw_make_immutable('run_errors');

CREATE TABLE provider_overloads (
  id bigserial PRIMARY KEY,
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  auth_profile_id text NOT NULL CHECK (auth_profile_id ~ '^[A-Za-z0-9._-]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX provider_overloads_recent ON provider_overloads (provider, auth_profile_id, created_at DESC);
SELECT pw_make_immutable('provider_overloads');
