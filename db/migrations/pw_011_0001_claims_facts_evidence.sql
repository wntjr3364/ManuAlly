-- PW-011: claims, evidence records and fact records (spec 02 "과학 근거", spec 05 "Evidence와 Fact").
-- Content is immutable. Review state moves only forward, through an explicit user action:
--   evidence/fact: CANDIDATE -> VERIFIED -> RETRACTED, CANDIDATE -> REJECTED
--   claim:         DRAFT     -> APPROVED -> RETRACTED, DRAFT     -> REJECTED
-- Rows are born in the pending state; the verifier/approver must be the paper's owner.

CREATE FUNCTION pw_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text := TG_ARGV[0];
  by_col text := TG_ARGV[1];
  at_col text := TG_ARGV[2];
  pending text := TG_ARGV[3];
  done text := TG_ARGV[4];
  review_cols text[] := ARRAY[TG_ARGV[0], TG_ARGV[1], TG_ARGV[2], 'closed_at'];
  n jsonb;
  o jsonb;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  n := to_jsonb(NEW);
  IF TG_OP = 'INSERT' THEN
    IF n->>st <> pending OR n->>by_col IS NOT NULL OR n->>at_col IS NOT NULL OR n->>'closed_at' IS NOT NULL THEN
      RAISE EXCEPTION 'illegal review transition on %: new rows start as % with no reviewer', TG_TABLE_NAME, pending USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD);
  IF (n - review_cols) IS DISTINCT FROM (o - review_cols) THEN
    RAISE EXCEPTION 'immutable: % content cannot change', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  ok := (n->>st = o->>st AND n->by_col IS NOT DISTINCT FROM o->by_col AND n->at_col IS NOT DISTINCT FROM o->at_col AND n->'closed_at' IS NOT DISTINCT FROM o->'closed_at')
     OR (o->>st = pending AND n->>st = done AND n->>by_col IS NOT NULL AND n->>at_col IS NOT NULL AND n->>'closed_at' IS NULL)
     OR (o->>st = pending AND n->>st = 'REJECTED' AND n->>by_col IS NULL AND n->>at_col IS NULL AND n->>'closed_at' IS NOT NULL)
     OR (o->>st = done AND n->>st = 'RETRACTED' AND n->by_col = o->by_col AND n->at_col = o->at_col AND n->>'closed_at' IS NOT NULL);
  IF NOT ok THEN
    RAISE EXCEPTION 'illegal review transition on %: % -> %', TG_TABLE_NAME, o->>st, n->>st USING ERRCODE = 'restrict_violation';
  END IF;
  IF n->>by_col IS NOT NULL AND (n->>by_col)::uuid IS DISTINCT FROM (SELECT owner_id FROM paper_projects WHERE id = NEW.paper_id) THEN
    RAISE EXCEPTION 'illegal review transition on %: the reviewer must be the paper owner', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE evidence_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  kind text NOT NULL CHECK (kind IN ('experiment', 'figure_panel', 'table_cell', 'literature_excerpt', 'method_record')),
  source_asset_revision_id uuid,
  reference_id uuid,
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object' AND locator <> '{}'::jsonb),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 500),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (origin IN ('user', 'import', 'ai_extraction')),
  extraction_state text NOT NULL DEFAULT 'CANDIDATE' CHECK (extraction_state IN ('CANDIDATE', 'VERIFIED', 'REJECTED', 'RETRACTED')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_by uuid REFERENCES owners(id),
  verified_at timestamptz,
  closed_at timestamptz,
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, source_asset_revision_id) REFERENCES asset_revisions(paper_id, id),
  FOREIGN KEY (paper_id, reference_id) REFERENCES project_references(paper_id, reference_id),
  CHECK (kind NOT IN ('figure_panel', 'table_cell') OR source_asset_revision_id IS NOT NULL),
  CHECK (kind <> 'literature_excerpt' OR reference_id IS NOT NULL)
);
CREATE TRIGGER evidence_records_review BEFORE INSERT OR UPDATE OR DELETE ON evidence_records
  FOR EACH ROW EXECUTE FUNCTION pw_review_guard('extraction_state', 'verified_by', 'verified_at', 'CANDIDATE', 'VERIFIED');
CREATE TRIGGER evidence_records_no_truncate BEFORE TRUNCATE ON evidence_records FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

CREATE TABLE fact_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  evidence_id uuid NOT NULL,
  entity text NOT NULL CHECK (length(btrim(entity)) BETWEEN 1 AND 200),
  metric text NOT NULL CHECK (length(btrim(metric)) BETWEEN 1 AND 200),
  value numeric NOT NULL,
  value_text text NOT NULL CHECK (value_text ~ '^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'),
  unit text NOT NULL CHECK (length(unit) <= 50),
  group_label text NOT NULL DEFAULT '' CHECK (length(group_label) <= 300),
  comparison text NOT NULL DEFAULT '' CHECK (length(comparison) <= 300),
  n integer CHECK (n IS NULL OR n >= 1),
  extraction_method text NOT NULL CHECK (extraction_method IN ('manual_entry', 'table_import', 'figure_reading', 'ai_extraction')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (origin IN ('user', 'import', 'ai_extraction')),
  verification_state text NOT NULL DEFAULT 'CANDIDATE' CHECK (verification_state IN ('CANDIDATE', 'VERIFIED', 'REJECTED', 'RETRACTED')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  verified_by uuid REFERENCES owners(id),
  verified_at timestamptz,
  closed_at timestamptz,
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, evidence_id) REFERENCES evidence_records(paper_id, id)
);
CREATE TRIGGER fact_records_stamp_xid BEFORE INSERT ON fact_records FOR EACH ROW EXECUTE FUNCTION pw_stamp_created_xid();
CREATE TRIGGER fact_records_review BEFORE INSERT OR UPDATE OR DELETE ON fact_records
  FOR EACH ROW EXECUTE FUNCTION pw_review_guard('verification_state', 'verified_by', 'verified_at', 'CANDIDATE', 'VERIFIED');
CREATE TRIGGER fact_records_no_truncate BEFORE TRUNCATE ON fact_records FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

-- a fact is verified only after the evidence it was read from
CREATE FUNCTION pw_fact_needs_verified_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_state = 'VERIFIED' AND OLD.verification_state <> 'VERIFIED'
     AND NOT EXISTS (SELECT 1 FROM evidence_records WHERE id = NEW.evidence_id AND extraction_state = 'VERIFIED') THEN
    RAISE EXCEPTION 'illegal review transition on fact_records: verify the source evidence first' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fact_records_evidence_first BEFORE UPDATE ON fact_records FOR EACH ROW EXECUTE FUNCTION pw_fact_needs_verified_evidence();

-- One row per statistic kind. p, adjusted p and q are separate kinds and are never merged.
CREATE TABLE fact_statistics (
  fact_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('p_value', 'adjusted_p_value', 'q_value', 'test_statistic', 'df', 'effect_size', 'sd', 'se', 'ci_lower', 'ci_upper', 'ci_level')),
  value numeric NOT NULL,
  value_text text NOT NULL CHECK (value_text ~ '^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'),
  test text NOT NULL DEFAULT '' CHECK (length(test) <= 200),
  adjustment text NOT NULL DEFAULT '' CHECK (length(adjustment) <= 200),
  PRIMARY KEY (fact_id, kind),
  FOREIGN KEY (paper_id, fact_id) REFERENCES fact_records(paper_id, id),
  CHECK (kind NOT IN ('p_value', 'adjusted_p_value', 'q_value') OR (value >= 0 AND value <= 1)),
  CHECK (kind <> 'adjusted_p_value' OR length(btrim(adjustment)) > 0)
);
SELECT pw_make_immutable('fact_statistics');
CREATE FUNCTION pw_fact_statistics_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fact_records WHERE id = NEW.fact_id AND created_xid = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'immutable: fact % is sealed; its statistics cannot change', NEW.fact_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fact_statistics_sealed AFTER INSERT ON fact_statistics FOR EACH ROW EXECUTE FUNCTION pw_fact_statistics_sealed();

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  kind text NOT NULL CHECK (kind IN ('observation', 'interpretation', 'hypothesis', 'background')),
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 2000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (origin IN ('user', 'import', 'ai_extraction')),
  approval_state text NOT NULL DEFAULT 'DRAFT' CHECK (approval_state IN ('DRAFT', 'APPROVED', 'REJECTED', 'RETRACTED')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by uuid REFERENCES owners(id),
  approved_at timestamptz,
  closed_at timestamptz,
  UNIQUE (paper_id, id)
);
CREATE TRIGGER claims_review BEFORE INSERT OR UPDATE OR DELETE ON claims
  FOR EACH ROW EXECUTE FUNCTION pw_review_guard('approval_state', 'approved_by', 'approved_at', 'DRAFT', 'APPROVED');
CREATE TRIGGER claims_no_truncate BEFORE TRUNCATE ON claims FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

CREATE TABLE claim_evidence_links (
  claim_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supports', 'contradicts', 'unclear', 'needs_check')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (claim_id, evidence_id),
  FOREIGN KEY (paper_id, claim_id) REFERENCES claims(paper_id, id),
  FOREIGN KEY (paper_id, evidence_id) REFERENCES evidence_records(paper_id, id)
);
SELECT pw_make_immutable('claim_evidence_links');
