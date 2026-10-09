-- PW-044: AI review of a manuscript paragraph, the owner's decisions, and one repair (spec 06 "검증 층"
-- B·C·D). A run keeps which revision and block it read, who reviewed (and whether that is the model
-- that wrote the paragraph), its findings and what was dropped. A finding is immutable except for the
-- owner's one decision. A run has at most one repair (UNIQUE run_id): the bound on repair loops.
CREATE TABLE review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL REFERENCES document_revisions(id),
  block_id uuid NOT NULL,
  block_hash text NOT NULL CHECK (block_hash ~ '^[0-9a-f]{64}$'),
  generator text NOT NULL CHECK (generator IN ('mock', 'claude_agent', 'codex')),
  generator_label text CHECK (generator_label IS NULL OR char_length(generator_label) <= 40),
  -- 'same_model': the reviewer is the model that wrote the paragraph (not an independent check)
  independence text NOT NULL CHECK (independence IN ('human_written', 'same_model', 'different_model')),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  dropped jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(dropped) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id)
);
SELECT pw_make_immutable('review_runs');

CREATE TABLE review_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  run_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  kind text NOT NULL CHECK (kind IN ('scientific', 'writing')),
  category text NOT NULL,
  quote text NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 2000),
  span_start integer NOT NULL CHECK (span_start >= 0),
  span_end integer NOT NULL CHECK (span_end > span_start),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  source_kind text CHECK (source_kind IS NULL OR source_kind IN ('claim', 'fact', 'evidence', 'profile', 'gate')),
  source_id text CHECK ((source_kind IS NULL) = (source_id IS NULL)),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  alternative text CHECK (alternative IS NULL OR char_length(alternative) <= 1000),
  warnings text[] NOT NULL DEFAULT '{}',
  decision text NOT NULL DEFAULT 'open' CHECK (decision IN ('open', 'accepted', 'dismissed')),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  decided_by uuid REFERENCES owners(id),
  decided_at timestamptz,
  CHECK ((decision = 'open') = (decided_at IS NULL)),
  UNIQUE (run_id, position),
  FOREIGN KEY (paper_id, run_id) REFERENCES review_runs(paper_id, id)
);
CREATE FUNCTION pw_044_finding_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.decision <> 'open'
     OR (to_jsonb(NEW) - 'decision' - 'note' - 'decided_by' - 'decided_at') <> (to_jsonb(OLD) - 'decision' - 'note' - 'decided_by' - 'decided_at') THEN
    RAISE EXCEPTION 'immutable: a review finding only gets the owner''s one decision' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_findings_decision BEFORE UPDATE OR DELETE ON review_findings FOR EACH ROW EXECUTE FUNCTION pw_044_finding_decision();
CREATE TRIGGER review_findings_no_truncate BEFORE TRUNCATE ON review_findings FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

CREATE TABLE review_repairs (
  run_id uuid PRIMARY KEY,
  paper_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  finding_ids uuid[] NOT NULL CHECK (cardinality(finding_ids) >= 1),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, run_id) REFERENCES review_runs(paper_id, id)
);
SELECT pw_make_immutable('review_repairs');
