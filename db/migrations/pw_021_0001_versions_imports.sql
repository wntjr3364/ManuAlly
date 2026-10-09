-- PW-021: undo of an applied AI edit, and text/Markdown import, without ever deleting history.
--   * 'undo' joins the revision reasons: an undo is a new head revision, like a restore
--   * proposal_undos: which revision undid which applied proposal (one undo per proposal)
--   * import_sources: the imported file as received (text, hash), the parser's preview and loss report;
--     stored before anything is applied and never changed
--   * import_applications: an import applied once, as a new manuscript or as a new version of it
ALTER TABLE document_revisions DROP CONSTRAINT document_revisions_reason_check;
ALTER TABLE document_revisions ADD CONSTRAINT document_revisions_reason_check CHECK (reason IN ('initial', 'manual', 'autosave', 'restore', 'import', 'ai_apply', 'undo'));

CREATE TABLE proposal_undos (
  proposal_id uuid PRIMARY KEY,
  paper_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, proposal_id) REFERENCES edit_proposals(paper_id, id),
  FOREIGN KEY (paper_id, document_id, revision_id) REFERENCES document_revisions(paper_id, document_id, id)
);
SELECT pw_make_immutable('proposal_undos');

CREATE TABLE import_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  format text NOT NULL CHECK (format IN ('text', 'markdown')),
  filename text CHECK (filename IS NULL OR char_length(filename) BETWEEN 1 AND 255),
  source_text text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size >= 0),
  parser_version text NOT NULL,
  preview_json jsonb NOT NULL CHECK (jsonb_typeof(preview_json) = 'object'),
  report_json jsonb NOT NULL CHECK (jsonb_typeof(report_json) = 'object'),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id)
);
SELECT pw_make_immutable('import_sources');

CREATE TABLE import_applications (
  import_id uuid PRIMARY KEY,
  paper_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL UNIQUE,
  mode text NOT NULL CHECK (mode IN ('new_manuscript', 'replace_manuscript')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, import_id) REFERENCES import_sources(paper_id, id),
  FOREIGN KEY (paper_id, document_id, revision_id) REFERENCES document_revisions(paper_id, document_id, id)
);
SELECT pw_make_immutable('import_applications');
