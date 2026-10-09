-- PW-039: story alternatives the AI proposes from the paper's own material (spec 03 "Storyline").
-- A run belongs to one job and one base story revision; its alternatives are stored as checked (with
-- the system's warnings and the reasons that block adoption) and never edited. Adopting one is the
-- owner's single decision: it records the DRAFT story revision it became.
ALTER TABLE jobs DROP CONSTRAINT jobs_intent_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_intent_check CHECK (intent IN ('draft_paragraph', 'revise_selection', 'ask_selection', 'review', 'extract_facts', 'literature_search', 'export', 'parse_source', 'propose_story'));

CREATE TABLE story_alternative_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  base_story_revision_id uuid NOT NULL REFERENCES story_revisions(id),
  generator text NOT NULL CHECK (generator IN ('mock', 'claude_agent', 'codex')),
  generator_label text CHECK (generator_label IS NULL OR char_length(generator_label) <= 40),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id)
);
SELECT pw_make_immutable('story_alternative_runs');

CREATE TABLE story_alternatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 5),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  warnings text[] NOT NULL DEFAULT '{}',
  blocked_reasons text[] NOT NULL DEFAULT '{}',
  adopted_story_revision_id uuid REFERENCES story_revisions(id),
  adopted_by uuid REFERENCES owners(id),
  adopted_at timestamptz,
  CHECK ((adopted_story_revision_id IS NULL) = (adopted_at IS NULL)),
  CHECK (adopted_story_revision_id IS NULL OR cardinality(blocked_reasons) = 0),
  UNIQUE (run_id, position),
  FOREIGN KEY (paper_id, run_id) REFERENCES story_alternative_runs(paper_id, id)
);
CREATE INDEX story_alternatives_paper ON story_alternatives (paper_id, run_id);
CREATE FUNCTION pw_039_adopt_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.adopted_at IS NOT NULL OR NEW.adopted_at IS NULL
     OR (to_jsonb(NEW) - 'adopted_story_revision_id' - 'adopted_by' - 'adopted_at') <> (to_jsonb(OLD) - 'adopted_story_revision_id' - 'adopted_by' - 'adopted_at') THEN
    RAISE EXCEPTION 'story_alternatives rows are immutable except one adoption (decided once)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER story_alternatives_adopt_once BEFORE UPDATE OR DELETE ON story_alternatives FOR EACH ROW EXECUTE FUNCTION pw_039_adopt_once();
CREATE TRIGGER story_alternatives_no_truncate BEFORE TRUNCATE ON story_alternatives FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
