-- PW-034: source documents (PDF originals) with their source, licence and rights (spec 05, 09).
-- The bytes live in a content-addressed store (sha256); asset_revisions (PW-009) holds the immutable
-- record. Here: where the file came from and what was inspected (immutable), the owner's rights
-- decisions as append-only revisions (the newest applies), and every URL fetch attempt.
CREATE TABLE asset_sources (
  asset_revision_id uuid PRIMARY KEY,
  paper_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES owners(id),
  kind text NOT NULL CHECK (kind IN ('source_pdf')),
  source text NOT NULL CHECK (source IN ('user_upload', 'open_access_fetch')),
  source_url text CHECK (source_url IS NULL OR (source_url ~ '^https?://' AND char_length(source_url) <= 2000)),
  reference_id uuid,
  page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 100000),
  inspected_with text NOT NULL CHECK (char_length(inspected_with) BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((source = 'open_access_fetch') = (source_url IS NOT NULL)),
  FOREIGN KEY (paper_id, asset_revision_id) REFERENCES asset_revisions(paper_id, id),
  FOREIGN KEY (owner_id, reference_id) REFERENCES reference_works(owner_id, id)
);
SELECT pw_make_immutable('asset_sources');

CREATE TABLE asset_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_revision_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  license text NOT NULL CHECK (license IN ('unknown', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd', 'cc0', 'public-domain', 'publisher-tdm', 'all-rights-reserved', 'own-work')),
  -- the right to keep / download the original, and separately the right to send it to an external AI
  keep_right text NOT NULL CHECK (keep_right IN ('unknown', 'user_supplied', 'open_license')),
  external_send text NOT NULL CHECK (external_send IN ('unknown', 'allowed', 'denied')),
  decided_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, asset_revision_id) REFERENCES asset_revisions(paper_id, id)
);
CREATE INDEX asset_policy_revisions_asset ON asset_policy_revisions (asset_revision_id, created_at DESC);
SELECT pw_make_immutable('asset_policy_revisions');

CREATE TABLE asset_fetches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  owner_id uuid NOT NULL REFERENCES owners(id),
  url text NOT NULL CHECK (char_length(url) <= 2000),
  host text CHECK (host IS NULL OR char_length(host) <= 255),
  outcome text NOT NULL CHECK (outcome IN ('stored', 'bad_url', 'host_not_allowed', 'internal_address', 'daily_cap', 'redirect', 'not_pdf', 'http_error', 'too_large', 'timeout', 'network', 'rejected_file')),
  asset_revision_id uuid,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'stored') = (asset_revision_id IS NOT NULL)),
  FOREIGN KEY (paper_id, asset_revision_id) REFERENCES asset_revisions(paper_id, id)
);
CREATE INDEX asset_fetches_owner_time ON asset_fetches (owner_id, attempted_at);
SELECT pw_make_immutable('asset_fetches');
