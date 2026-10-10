-- PW-048: context switches of a job's provider session (spec 08 "압축 시점"). At a safe boundary a run
-- that nears its request budget compacts the session (only where the provider's compaction is verified,
-- and only once the provider confirms it) or replaces it with a new session started from the rehydrated
-- checkpoint (PW-047). Each step is recorded with the reading that caused it: the current request's input
-- (never cumulative billed tokens), the window, where the numbers came from. A reading that is not known
-- stays NULL. Only the run holding the job's current fencing token writes. Rows are never changed.
CREATE TABLE context_switches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  job_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  kind text NOT NULL CHECK (kind IN ('checkpoint_review', 'compact_requested', 'compact_confirmed', 'compact_failed', 'session_replaced')),
  from_session text NOT NULL CHECK (char_length(from_session) BETWEEN 1 AND 200),
  to_session text CHECK (to_session IS NULL OR char_length(to_session) BETWEEN 1 AND 200),
  context_window integer CHECK (context_window IS NULL OR context_window >= 1),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  input_source text NOT NULL CHECK (input_source IN ('provider_reported', 'estimated', 'unknown')),
  occupancy numeric(6, 4) CHECK (occupancy IS NULL OR occupancy >= 0),
  checkpoint_id uuid REFERENCES job_checkpoints(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, seq),
  FOREIGN KEY (paper_id, job_id) REFERENCES jobs(paper_id, id),
  CHECK ((kind = 'session_replaced') = (to_session IS NOT NULL)),
  CHECK ((input_source = 'unknown') = (input_tokens IS NULL)),
  CHECK (occupancy IS NULL OR (context_window IS NOT NULL AND input_tokens IS NOT NULL))
);
SELECT pw_make_immutable('context_switches');
