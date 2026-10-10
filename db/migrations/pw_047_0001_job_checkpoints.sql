-- PW-047: job checkpoints (spec 08 "Checkpoint"). At each boundary of an AI job — before a provider call,
-- after the answer is validated, after the proposal is stored, or when the session changes — the worker
-- writes what a new session needs, without any model call: the approved objects by id and hash, the
-- completed actions, the pending step, policy and versions, the provider session. Only the run holding
-- the job's current fencing token writes (checked by the writer in the same statement order). A summary
-- may be attached; it is an unverified note, never evidence or approval. Rows are never changed.
CREATE TABLE job_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  job_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  boundary text NOT NULL CHECK (boundary IN ('before_call', 'after_validation', 'after_proposal', 'session_change', 'maintenance')),
  pending_step text CHECK (pending_step IS NULL OR pending_step ~ '^[a-z][a-z_]{0,49}$'),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  summary text CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 4000),
  summary_source text CHECK (summary_source IS NULL OR summary_source IN ('ai', 'user')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, seq),
  FOREIGN KEY (paper_id, job_id) REFERENCES jobs(paper_id, id),
  CHECK ((summary IS NULL) = (summary_source IS NULL))
);
CREATE INDEX job_checkpoints_job ON job_checkpoints (job_id, seq DESC);
SELECT pw_make_immutable('job_checkpoints');
