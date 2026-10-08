-- PW-009: immutable revisions and named snapshots.
-- Rules enforced here (not only in the API):
--   * revision and snapshot rows are append-only (UPDATE/DELETE/TRUNCATE raise "immutable")
--   * every link between paper-owned rows carries paper_id in a composite foreign key, so one
--     paper's rows can never reference another paper's rows

CREATE FUNCTION pw_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable: % rows cannot be %d', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE FUNCTION pw_make_immutable(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pw_forbid_change()', t::text || '_immutable_row', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change()', t::text || '_immutable_truncate', t);
END $$;

-- Documents (manuscript, notes, ...) and their revisions -------------------------------------
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  kind text NOT NULL CHECK (kind IN ('manuscript', 'notes', 'response_letter', 'supplement')),
  head_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (paper_id, id)
);

CREATE TABLE document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  document_id uuid NOT NULL,
  parent_revision_id uuid,
  restored_from_revision_id uuid,
  content_json jsonb NOT NULL CHECK (jsonb_typeof(content_json) = 'object'),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES owners(id),
  reason text NOT NULL CHECK (reason IN ('initial', 'manual', 'autosave', 'restore', 'import', 'ai_apply')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id),
  UNIQUE (paper_id, document_id, id),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id),
  FOREIGN KEY (paper_id, document_id, parent_revision_id) REFERENCES document_revisions(paper_id, document_id, id),
  FOREIGN KEY (paper_id, document_id, restored_from_revision_id) REFERENCES document_revisions(paper_id, document_id, id)
);
CREATE INDEX document_revisions_doc_idx ON document_revisions(document_id, created_at DESC);
SELECT pw_make_immutable('document_revisions');

-- the head must be a revision of the same document (deferred: document and first revision are
-- inserted in one transaction)
ALTER TABLE documents ADD CONSTRAINT documents_head_fk
  FOREIGN KEY (paper_id, id, head_revision_id) REFERENCES document_revisions(paper_id, document_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Bibliographic and asset revisions (minimal now; literature/asset tasks P04 extend them) ----
CREATE TABLE reference_works (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  doi text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id)
);
CREATE TABLE bibliographic_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES reference_works(id),
  csl_json jsonb NOT NULL CHECK (jsonb_typeof(csl_json) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source text NOT NULL CHECK (source IN ('manual', 'doi_lookup', 'import', 'zotero')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (reference_id, id)
);
SELECT pw_make_immutable('bibliographic_revisions');
CREATE TABLE project_references (
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  reference_id uuid NOT NULL REFERENCES reference_works(id),
  use_role text NOT NULL DEFAULT 'scientific' CHECK (use_role IN ('scientific', 'writing', 'both')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (paper_id, reference_id)
);

CREATE TABLE asset_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  asset_key text NOT NULL,             -- stable logical asset (e.g. figure-1) across versions
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  media_type text NOT NULL,
  original_name text,
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id)
);
SELECT pw_make_immutable('asset_revisions');

-- Named snapshots: an exact manifest of revision ids --------------------------------------
CREATE TABLE paper_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id)
);
SELECT pw_make_immutable('paper_snapshots');

CREATE TABLE snapshot_document_revisions (
  snapshot_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  PRIMARY KEY (snapshot_id, document_id),
  FOREIGN KEY (paper_id, snapshot_id) REFERENCES paper_snapshots(paper_id, id),
  FOREIGN KEY (paper_id, document_id, revision_id) REFERENCES document_revisions(paper_id, document_id, id)
);
SELECT pw_make_immutable('snapshot_document_revisions');

CREATE TABLE snapshot_reference_revisions (
  snapshot_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  reference_id uuid NOT NULL,
  bibliographic_revision_id uuid NOT NULL,
  PRIMARY KEY (snapshot_id, reference_id),
  FOREIGN KEY (paper_id, snapshot_id) REFERENCES paper_snapshots(paper_id, id),
  FOREIGN KEY (paper_id, reference_id) REFERENCES project_references(paper_id, reference_id),
  FOREIGN KEY (reference_id, bibliographic_revision_id) REFERENCES bibliographic_revisions(reference_id, id)
);
SELECT pw_make_immutable('snapshot_reference_revisions');

CREATE TABLE snapshot_asset_revisions (
  snapshot_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  asset_revision_id uuid NOT NULL,
  PRIMARY KEY (snapshot_id, asset_revision_id),
  FOREIGN KEY (paper_id, snapshot_id) REFERENCES paper_snapshots(paper_id, id),
  FOREIGN KEY (paper_id, asset_revision_id) REFERENCES asset_revisions(paper_id, id)
);
SELECT pw_make_immutable('snapshot_asset_revisions');
