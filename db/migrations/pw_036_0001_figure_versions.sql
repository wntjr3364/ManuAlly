-- PW-036: figure/table versions, their source evidence, and review flags (spec 05 "Figure/Table 관리").
-- A figure object (PW-019) keeps its id and number; each change of its file, caption, panels, units or
-- groups is a new immutable version. Evidence (figure_panel / table_cell) is linked to the version it
-- was read from. A new version never silently changes what a paragraph or claim relies on: the
-- paragraphs that mention the figure, the claims and the facts linked to it get open review flags,
-- which only the owner closes.
ALTER TABLE asset_sources DROP CONSTRAINT asset_sources_kind_check;
ALTER TABLE asset_sources ADD CONSTRAINT asset_sources_kind_check CHECK (kind IN ('source_pdf', 'figure_file'));

CREATE TABLE figure_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  figure_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  caption text NOT NULL CHECK (char_length(caption) <= 5000),
  -- panels / table parts: [{ panel, unit, groups: [..], description }]
  panels jsonb NOT NULL CHECK (jsonb_typeof(panels) = 'array'),
  asset_revision_id uuid,
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (figure_id, version_no),
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, figure_id) REFERENCES figure_objects(paper_id, id),
  FOREIGN KEY (paper_id, asset_revision_id) REFERENCES asset_revisions(paper_id, id)
);
SELECT pw_make_immutable('figure_versions');

CREATE TABLE figure_evidence_links (
  evidence_id uuid PRIMARY KEY,
  paper_id uuid NOT NULL,
  figure_id uuid NOT NULL,
  figure_version_id uuid NOT NULL,
  panel text NOT NULL DEFAULT '' CHECK (char_length(panel) <= 50),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, evidence_id) REFERENCES evidence_records(paper_id, id),
  FOREIGN KEY (paper_id, figure_id) REFERENCES figure_objects(paper_id, id),
  FOREIGN KEY (paper_id, figure_version_id) REFERENCES figure_versions(paper_id, id)
);
SELECT pw_make_immutable('figure_evidence_links');

CREATE TABLE figure_review_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  figure_id uuid NOT NULL,
  from_version_id uuid NOT NULL,
  to_version_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('paragraph', 'claim', 'fact')),
  document_id uuid,
  block_id text CHECK (block_id IS NULL OR char_length(block_id) <= 100),
  claim_id uuid,
  fact_id uuid,
  reasons text[] NOT NULL CHECK (cardinality(reasons) >= 1),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  resolved_by uuid REFERENCES owners(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((target_kind = 'paragraph') = (block_id IS NOT NULL AND document_id IS NOT NULL)),
  CHECK ((target_kind = 'claim') = (claim_id IS NOT NULL)),
  CHECK ((target_kind = 'fact') = (fact_id IS NOT NULL)),
  CHECK ((status = 'open') = (resolved_at IS NULL)),
  FOREIGN KEY (paper_id, figure_id) REFERENCES figure_objects(paper_id, id),
  FOREIGN KEY (paper_id, from_version_id) REFERENCES figure_versions(paper_id, id),
  FOREIGN KEY (paper_id, to_version_id) REFERENCES figure_versions(paper_id, id),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id),
  FOREIGN KEY (paper_id, claim_id) REFERENCES claims(paper_id, id),
  FOREIGN KEY (paper_id, fact_id) REFERENCES fact_records(paper_id, id)
);
CREATE INDEX figure_review_flags_open ON figure_review_flags (paper_id) WHERE status = 'open';
CREATE FUNCTION pw_036_resolve_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.status <> 'open' OR NEW.status <> 'resolved' OR NEW.resolved_by IS NULL
     OR (to_jsonb(NEW) - 'status' - 'resolution_note' - 'resolved_by' - 'resolved_at') <> (to_jsonb(OLD) - 'status' - 'resolution_note' - 'resolved_by' - 'resolved_at') THEN
    RAISE EXCEPTION 'figure_review_flags rows are immutable except one resolution by the owner' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.resolved_by IS DISTINCT FROM (SELECT owner_id FROM paper_projects WHERE id = NEW.paper_id) THEN
    RAISE EXCEPTION 'only the paper owner resolves a review flag' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER figure_review_flags_resolve_once BEFORE UPDATE OR DELETE ON figure_review_flags FOR EACH ROW EXECUTE FUNCTION pw_036_resolve_once();
CREATE TRIGGER figure_review_flags_no_truncate BEFORE TRUNCATE ON figure_review_flags FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
