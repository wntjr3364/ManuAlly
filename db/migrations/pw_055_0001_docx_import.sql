-- PW-055: DOCX import. An import source may be a .docx: its bytes are kept as received (source_bytes, with
-- their SHA-256) and it has no text form (source_text NULL); text and Markdown keep both, as before.
-- The table stays immutable (pw_make_immutable from pw_021_0001): an original is never changed or deleted.
ALTER TABLE import_sources DROP CONSTRAINT IF EXISTS import_sources_format_check;
ALTER TABLE import_sources ADD CONSTRAINT import_sources_format_check CHECK (format IN ('text', 'markdown', 'docx'));
ALTER TABLE import_sources ALTER COLUMN source_text DROP NOT NULL;
ALTER TABLE import_sources ADD CONSTRAINT import_sources_docx_bytes CHECK (
  (format = 'docx' AND source_text IS NULL AND source_bytes IS NOT NULL) OR (format <> 'docx' AND source_text IS NOT NULL)
);
