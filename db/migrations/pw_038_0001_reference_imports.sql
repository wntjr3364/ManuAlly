-- PW-038: imports of portable reference files (CSL-JSON, BibTeX, RIS, DOI lists) and read-only Zotero
-- imports (spec 05 "Zotero와 이식성"). Each import is recorded with its format, source and the hash of
-- what was read, and the outcome of every entry. Entries without a DOI keep a stable id through their
-- source key (format + citekey/ID), per owner. All rows are immutable.
CREATE TABLE reference_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  owner_id uuid NOT NULL REFERENCES owners(id),
  format text NOT NULL CHECK (format IN ('csl-json', 'bibtex', 'ris', 'doi-list')),
  source text NOT NULL CHECK (source IN ('import', 'zotero')),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
SELECT pw_make_immutable('reference_imports');

CREATE TABLE reference_import_items (
  import_id uuid NOT NULL REFERENCES reference_imports(id),
  position integer NOT NULL CHECK (position >= 1),
  entry_key text NOT NULL CHECK (char_length(entry_key) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('created', 'linked_existing', 'kept_library_metadata', 'already_in_paper', 'invalid', 'unknown_doi')),
  reference_id uuid REFERENCES reference_works(id),
  warnings text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (import_id, position),
  CHECK ((status IN ('invalid', 'unknown_doi')) = (reference_id IS NULL))
);
SELECT pw_make_immutable('reference_import_items');

CREATE TABLE reference_import_keys (
  owner_id uuid NOT NULL REFERENCES owners(id),
  format text NOT NULL CHECK (format IN ('csl-json', 'bibtex', 'ris', 'doi-list')),
  entry_key text NOT NULL CHECK (char_length(entry_key) BETWEEN 1 AND 200),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, format, entry_key),
  FOREIGN KEY (owner_id, reference_id) REFERENCES reference_works(owner_id, id)
);
SELECT pw_make_immutable('reference_import_keys');
