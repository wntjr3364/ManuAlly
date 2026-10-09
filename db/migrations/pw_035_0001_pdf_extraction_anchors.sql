-- PW-035: text extracted from a source PDF and confirmed evidence locations in it (spec 05 "PDF
-- 파이프라인", "PDF anchor").
-- An extraction belongs to one immutable asset revision (and its sha256) and one extractor version;
-- it is all-or-nothing (status ok / no_text / failed — a failed one has no pages). Pages keep their
-- size, /Rotate, the plain text and the positioned text runs, plus flags for reading-order risks.
-- An anchor is a location the owner confirmed: asset revision, sha256, 0-based page, normalized
-- quadpoints, the exact quote with prefix/suffix and the extractor version. Nothing here is ever
-- moved to another revision automatically.
ALTER TABLE jobs DROP CONSTRAINT jobs_intent_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_intent_check CHECK (intent IN ('draft_paragraph', 'revise_selection', 'ask_selection', 'review', 'extract_facts', 'literature_search', 'export', 'parse_source'));

CREATE TABLE pdf_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  asset_revision_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  extractor text NOT NULL CHECK (char_length(extractor) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('ok', 'no_text', 'failed')),
  failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 500),
  page_count integer CHECK (page_count IS NULL OR page_count >= 0),
  job_id uuid REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  UNIQUE (asset_revision_id, extractor),
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, asset_revision_id) REFERENCES asset_revisions(paper_id, id)
);
SELECT pw_make_immutable('pdf_extractions');

CREATE TABLE pdf_pages (
  extraction_id uuid NOT NULL REFERENCES pdf_extractions(id),
  page_index integer NOT NULL CHECK (page_index >= 0),
  view_box double precision[] NOT NULL CHECK (cardinality(view_box) = 4),
  rotate integer NOT NULL CHECK (rotate IN (0, 90, 180, 270)),
  text text NOT NULL,
  runs jsonb NOT NULL CHECK (jsonb_typeof(runs) = 'array'),
  flags text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (extraction_id, page_index)
);
SELECT pw_make_immutable('pdf_pages');

CREATE TABLE pdf_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  asset_revision_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  extraction_id uuid NOT NULL,
  extractor text NOT NULL,
  page_index integer NOT NULL CHECK (page_index >= 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL,
  exact text NOT NULL CHECK (char_length(exact) BETWEEN 1 AND 2000),
  prefix text NOT NULL DEFAULT '' CHECK (char_length(prefix) <= 200),
  suffix text NOT NULL DEFAULT '' CHECK (char_length(suffix) <= 200),
  quadpoints jsonb NOT NULL CHECK (jsonb_typeof(quadpoints) = 'array'),
  precision text NOT NULL CHECK (precision IN ('run_interpolated')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (end_offset > start_offset),
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, asset_revision_id) REFERENCES asset_revisions(paper_id, id),
  FOREIGN KEY (paper_id, extraction_id) REFERENCES pdf_extractions(paper_id, id),
  FOREIGN KEY (extraction_id, page_index) REFERENCES pdf_pages(extraction_id, page_index)
);
SELECT pw_make_immutable('pdf_anchors');
