-- PW-020: AI requests on a selection run as jobs and report progress as append-only events.
--   * 'ask_selection' joins the job intents (questions never change the manuscript)
--   * job_events: what the run reported (answer text pieces, status notes, the proposal id), in
--     order, never changed. A browser that disconnects reads them again from where it stopped.
ALTER TABLE jobs DROP CONSTRAINT jobs_intent_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_intent_check CHECK (intent IN ('draft_paragraph', 'revise_selection', 'ask_selection', 'review', 'extract_facts', 'literature_search', 'export'));

CREATE TABLE job_events (
  paper_id uuid NOT NULL,
  job_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  kind text NOT NULL CHECK (kind IN ('status', 'delta', 'answer_done', 'proposal', 'no_change', 'error')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, seq),
  FOREIGN KEY (paper_id, job_id) REFERENCES jobs(paper_id, id)
);
SELECT pw_make_immutable('job_events');
