-- PW-032: the owner's reference library built from search candidates (spec 05 "문헌 선택 실패", 02).
-- A work (reference_works) is identified only by verifiable identifiers: a DOI or a PMID, unique per
-- owner. Its metadata is a sequence of immutable bibliographic revisions: a change at the source adds
-- a version; citation snapshots keep pointing at the version they pinned. Relations between works
-- (preprint ↔ published, correction, retraction) are kept as observed. A similar title alone never
-- merges works: it is listed as a possible duplicate for the owner to decide.
ALTER TABLE bibliographic_revisions DROP CONSTRAINT bibliographic_revisions_source_check;
ALTER TABLE bibliographic_revisions ADD CONSTRAINT bibliographic_revisions_source_check CHECK (source IN ('manual', 'doi_lookup', 'import', 'zotero', 'crossref', 'pubmed'));
ALTER TABLE bibliographic_revisions ADD COLUMN source_candidate_id uuid REFERENCES literature_candidates(id);

CREATE TABLE reference_identifiers (
  owner_id uuid NOT NULL REFERENCES owners(id),
  reference_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('doi', 'pmid')),
  value text NOT NULL CHECK ((kind = 'doi' AND value ~ '^10\.[0-9]{4,9}/\S+$' AND value = lower(value)) OR (kind = 'pmid' AND value ~ '^[1-9][0-9]{0,11}$')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, kind, value),
  FOREIGN KEY (owner_id, reference_id) REFERENCES reference_works(owner_id, id)
);
CREATE INDEX reference_identifiers_ref ON reference_identifiers (reference_id);
SELECT pw_make_immutable('reference_identifiers');

CREATE TABLE reference_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  from_reference_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('is_preprint_of', 'has_preprint', 'is_version_of', 'has_version', 'retraction_of', 'correction_of', 'expression_of_concern_for', 'erratum_for', 'flagged_retracted', 'flagged_erratum', 'flagged_expression_of_concern', 'update_of')),
  to_reference_id uuid,
  to_doi text CHECK (to_doi IS NULL OR to_doi ~ '^10\.[0-9]{4,9}/\S+$'),
  source text NOT NULL CHECK (source IN ('crossref', 'pubmed', 'manual')),
  source_candidate_id uuid REFERENCES literature_candidates(id),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (owner_id, from_reference_id) REFERENCES reference_works(owner_id, id),
  FOREIGN KEY (owner_id, to_reference_id) REFERENCES reference_works(owner_id, id)
);
CREATE UNIQUE INDEX reference_relations_once ON reference_relations (owner_id, from_reference_id, relation, coalesce(to_doi, ''), coalesce(to_reference_id::text, ''));
SELECT pw_make_immutable('reference_relations');

CREATE TABLE reference_duplicate_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  reference_a uuid NOT NULL,
  reference_b uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('similar_title', 'identifier_conflict')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'distinct', 'same')),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (reference_a < reference_b),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  UNIQUE (owner_id, reference_a, reference_b, reason),
  FOREIGN KEY (owner_id, reference_a) REFERENCES reference_works(owner_id, id),
  FOREIGN KEY (owner_id, reference_b) REFERENCES reference_works(owner_id, id)
);
-- only the owner's decision may change a question, once
CREATE FUNCTION pw_032_decide_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.status <> 'open' OR NEW.status = 'open'
     OR (to_jsonb(NEW) - 'status' - 'decided_at') <> (to_jsonb(OLD) - 'status' - 'decided_at') THEN
    RAISE EXCEPTION 'reference_duplicate_questions rows are immutable except one decision' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reference_duplicate_questions_once BEFORE UPDATE OR DELETE ON reference_duplicate_questions FOR EACH ROW EXECUTE FUNCTION pw_032_decide_once();
