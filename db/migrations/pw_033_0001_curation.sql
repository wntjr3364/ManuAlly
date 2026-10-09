-- PW-033: AI curation of literature candidates (spec 05 "논문을 AI가 선정하는 방식").
-- A curation run records which assessor (provider) looked at which searches for which paper. Each
-- assessment is a suggestion: the candidate's use (scientific / writing / both / exclude), its fit, the
-- read depth the system knows (not the assessor's claim), the reasons and the exclusion reason, plus
-- system warnings. The owner's decision (accepted / rejected) is the only change ever made to a row.
CREATE TABLE curation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  job_id uuid REFERENCES jobs(id),
  assessor text NOT NULL CHECK (assessor IN ('mock', 'claude_agent', 'codex')),
  assessor_label text CHECK (assessor_label IS NULL OR char_length(assessor_label) <= 20),
  search_ids uuid[] NOT NULL CHECK (cardinality(search_ids) BETWEEN 1 AND 20),
  brief_hash text NOT NULL CHECK (brief_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id)
);
SELECT pw_make_immutable('curation_runs');

CREATE TABLE curation_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  candidate_id uuid NOT NULL REFERENCES literature_candidates(id),
  role text NOT NULL CHECK (role IN ('scientific', 'writing', 'both', 'exclude')),
  topic_fit text NOT NULL CHECK (topic_fit IN ('high', 'medium', 'low', 'unknown')),
  article_type_fit text NOT NULL CHECK (article_type_fit IN ('high', 'medium', 'low', 'unknown')),
  style_fit text NOT NULL CHECK (style_fit IN ('good', 'fair', 'poor', 'unknown')),
  read_depth text NOT NULL CHECK (read_depth IN ('METADATA_ONLY', 'ABSTRACT_ONLY', 'FULLTEXT_PARTIAL', 'FULLTEXT_PARSED', 'SOURCE_CHECKED')),
  reasons text NOT NULL CHECK (char_length(reasons) BETWEEN 5 AND 1000),
  exclusion_reason text CHECK (exclusion_reason IS NULL OR char_length(exclusion_reason) BETWEEN 3 AND 500),
  warnings text[] NOT NULL DEFAULT '{}',
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'accepted', 'rejected')),
  decided_use_role text CHECK (decided_use_role IS NULL OR decided_use_role IN ('scientific', 'writing', 'both')),
  decided_by uuid REFERENCES owners(id),
  decided_at timestamptz,
  CHECK (role <> 'exclude' OR exclusion_reason IS NOT NULL),
  CHECK ((decision = 'pending') = (decided_at IS NULL)),
  CHECK ((decision = 'accepted') = (decided_use_role IS NOT NULL)),
  UNIQUE (run_id, candidate_id),
  FOREIGN KEY (paper_id, run_id) REFERENCES curation_runs(paper_id, id)
);
CREATE INDEX curation_assessments_paper ON curation_assessments (paper_id, run_id);
CREATE FUNCTION pw_033_decide_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.decision <> 'pending' OR NEW.decision = 'pending'
     OR (to_jsonb(NEW) - 'decision' - 'decided_use_role' - 'decided_by' - 'decided_at') <> (to_jsonb(OLD) - 'decision' - 'decided_use_role' - 'decided_by' - 'decided_at') THEN
    RAISE EXCEPTION 'curation_assessments rows are immutable except one owner decision' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER curation_assessments_decide_once BEFORE UPDATE OR DELETE ON curation_assessments FOR EACH ROW EXECUTE FUNCTION pw_033_decide_once();
CREATE TRIGGER curation_assessments_no_truncate BEFORE TRUNCATE ON curation_assessments FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
