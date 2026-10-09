-- PW-041: WritingProfile (spec 06). A profile is proposed from the sections of writing references that
-- were actually read, or written by the owner; every version is immutable, and approving one (the
-- owner's act) makes it the paper's active profile and supersedes the previous one. What the system
-- removed from a proposal (rules from unread sections, copied wording) is kept with the reason. The
-- owner's feedback is a candidate for the next proposal, never applied by itself.
ALTER TABLE jobs DROP CONSTRAINT jobs_intent_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_intent_check CHECK (intent IN ('draft_paragraph', 'revise_selection', 'ask_selection', 'review', 'extract_facts', 'literature_search', 'export', 'parse_source', 'propose_story', 'propose_profile'));

CREATE TABLE writing_profile_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  generator text NOT NULL CHECK (generator IN ('mock', 'claude_agent', 'codex')),
  generator_label text CHECK (generator_label IS NULL OR char_length(generator_label) <= 40),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id)
);
SELECT pw_make_immutable('writing_profile_runs');

CREATE TABLE writing_profile_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  parent_revision_id uuid REFERENCES writing_profile_revisions(id),
  run_id uuid,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  -- what each rule was drawn from: reference, extraction, file hash, sections read
  sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array'),
  removed jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(removed) = 'array'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'SUPERSEDED')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by uuid REFERENCES owners(id),
  approved_at timestamptz,
  superseded_at timestamptz,
  CHECK ((status = 'DRAFT') = (approved_at IS NULL)),
  CHECK ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL)),
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, run_id) REFERENCES writing_profile_runs(paper_id, id)
);
CREATE UNIQUE INDEX writing_profile_one_approved ON writing_profile_revisions (paper_id) WHERE status = 'APPROVED';
CREATE FUNCTION pw_041_profile_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR (to_jsonb(NEW) - 'status' - 'approved_by' - 'approved_at' - 'superseded_at') <> (to_jsonb(OLD) - 'status' - 'approved_by' - 'approved_at' - 'superseded_at')
     OR NOT ((OLD.status = 'DRAFT' AND NEW.status = 'APPROVED') OR (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED'))
     OR (OLD.status = 'APPROVED' AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)) THEN
    RAISE EXCEPTION 'immutable: a writing profile revision only moves DRAFT -> APPROVED -> SUPERSEDED' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER writing_profile_revisions_status BEFORE UPDATE OR DELETE ON writing_profile_revisions FOR EACH ROW EXECUTE FUNCTION pw_041_profile_status();
CREATE TRIGGER writing_profile_revisions_no_truncate BEFORE TRUNCATE ON writing_profile_revisions FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

CREATE TABLE writing_profile_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  text text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
SELECT pw_make_immutable('writing_profile_feedback');
