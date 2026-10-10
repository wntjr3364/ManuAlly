-- PW-057: two more export formats. 'pdf' (the reading PDF, converted from the app's DOCX) keeps its bytes in
-- the row like the PW-056 formats. 'source_archive' is made from a named snapshot for a purpose ('share':
-- only originals whose licence allows passing them on; 'private': the owner's own copy with every original);
-- its bytes can be large, so they live in the content-addressed asset store and the row keeps their SHA-256
-- (the download re-checks it). An archive whose originals were not all found is 'incomplete'.
-- Rows stay immutable (pw_make_immutable on exports, PW-056).
ALTER TABLE exports DROP CONSTRAINT exports_format_check;
ALTER TABLE exports ADD CONSTRAINT exports_format_check CHECK (format IN ('docx', 'csl_json', 'pdf', 'source_archive'));
ALTER TABLE exports DROP CONSTRAINT exports_status_check;
ALTER TABLE exports ADD CONSTRAINT exports_status_check CHECK (status IN ('clean', 'needs_attention', 'draft_with_errors', 'incomplete'));
ALTER TABLE exports ADD COLUMN snapshot_id uuid;
ALTER TABLE exports ADD COLUMN purpose text CHECK (purpose IN ('share', 'private'));
ALTER TABLE exports ADD COLUMN in_asset_store boolean NOT NULL DEFAULT false;
ALTER TABLE exports ALTER COLUMN file_bytes DROP NOT NULL;
ALTER TABLE exports ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE exports ALTER COLUMN revision_id DROP NOT NULL;
ALTER TABLE exports ADD CONSTRAINT exports_snapshot_fk FOREIGN KEY (paper_id, snapshot_id) REFERENCES paper_snapshots(paper_id, id);
ALTER TABLE exports ADD CONSTRAINT exports_archive_shape CHECK (
  (format = 'source_archive') = (snapshot_id IS NOT NULL)
  AND (format = 'source_archive') = (purpose IS NOT NULL)
  AND (format = 'source_archive') = in_asset_store
  AND in_asset_store = (file_bytes IS NULL)
  AND (format = 'source_archive' OR (document_id IS NOT NULL AND revision_id IS NOT NULL))
  AND (document_id IS NULL) = (revision_id IS NULL)
  AND (status <> 'incomplete' OR format = 'source_archive')
);
