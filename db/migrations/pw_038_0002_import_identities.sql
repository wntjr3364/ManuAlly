-- PW-038 review (MAJOR): a source key alone is not an identity. Citekeys repeat across files, RIS and
-- CSL entries often have no key at all (only a position). A work without a DOI is found again only by
-- the same source (file format, or one Zotero library), the same source key (or none) and the same
-- content; anything else is a new work. Nothing has been deployed: the old key table is replaced.
DROP TABLE reference_import_keys;
CREATE TABLE reference_import_identities (
  owner_id uuid NOT NULL REFERENCES owners(id),
  scope text NOT NULL CHECK (scope ~ '^(file:(csl-json|bibtex|ris)|zotero:(user|group):[0-9]{1,12})$'),
  entry_key text NOT NULL CHECK (char_length(entry_key) <= 200), -- '' when the entry had no key of its own
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope, entry_key, content_hash),
  FOREIGN KEY (owner_id, reference_id) REFERENCES reference_works(owner_id, id)
);
SELECT pw_make_immutable('reference_import_identities');
ALTER TABLE reference_imports ADD COLUMN scope text CHECK (scope ~ '^(file:(csl-json|bibtex|ris|doi-list)|zotero:(user|group):[0-9]{1,12})$');
