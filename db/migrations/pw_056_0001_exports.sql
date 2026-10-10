-- PW-056: exports of a manuscript. One row per export: the exact revision it was made from, the format, the
-- check status and report, the renderer and citation style versions, and the file itself with its SHA-256.
-- Rows are never changed or deleted (an export is a record of what was handed out).
CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('docx', 'csl_json')),
  status text NOT NULL CHECK (status IN ('clean', 'needs_attention', 'draft_with_errors')),
  style text NOT NULL,
  style_version text NOT NULL,
  renderer_version text NOT NULL,
  report_json jsonb NOT NULL CHECK (jsonb_typeof(report_json) = 'object'),
  file_bytes bytea NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size >= 0),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id),
  FOREIGN KEY (paper_id, revision_id) REFERENCES document_revisions(paper_id, id),
  UNIQUE (paper_id, id)
);
CREATE INDEX exports_paper ON exports (paper_id, created_at DESC);
SELECT pw_make_immutable('exports');
