-- PW-032 review fixes.
-- 1. DOIs of works entered before PW-032 (manual references) become identifiers, lowercased. The oldest
--    work holds a DOI; another work with the same DOI (or one whose DOI is already held) is not merged:
--    it becomes an identifier_conflict question for the owner.
-- 2. A work's own "updated" status (Crossref updated-by kinds other than retraction, correction and
--    expression of concern, e.g. withdrawal or removal) is a flag too.
-- 3. Duplicate questions cannot be truncated.
WITH dois AS (
  SELECT id, owner_id, lower(btrim(doi)) AS v, created_at FROM reference_works
  WHERE doi IS NOT NULL AND lower(btrim(doi)) ~ '^10\.[0-9]{4,9}/\S+$'
)
INSERT INTO reference_identifiers (owner_id, reference_id, kind, value)
SELECT DISTINCT ON (owner_id, v) owner_id, id, 'doi', v FROM dois
WHERE NOT EXISTS (SELECT 1 FROM reference_identifiers i WHERE i.owner_id = dois.owner_id AND i.kind = 'doi' AND i.value = dois.v)
ORDER BY owner_id, v, created_at, id;

INSERT INTO reference_duplicate_questions (owner_id, reference_a, reference_b, reason)
SELECT w.owner_id, least(w.id, i.reference_id), greatest(w.id, i.reference_id), 'identifier_conflict'
FROM reference_works w JOIN reference_identifiers i ON i.owner_id = w.owner_id AND i.kind = 'doi' AND i.value = lower(btrim(w.doi))
WHERE w.doi IS NOT NULL AND i.reference_id <> w.id
ON CONFLICT DO NOTHING;

ALTER TABLE reference_relations DROP CONSTRAINT reference_relations_relation_check;
ALTER TABLE reference_relations ADD CONSTRAINT reference_relations_relation_check CHECK (relation IN ('is_preprint_of', 'has_preprint', 'is_version_of', 'has_version', 'retraction_of', 'correction_of', 'expression_of_concern_for', 'erratum_for', 'flagged_retracted', 'flagged_erratum', 'flagged_expression_of_concern', 'flagged_updated', 'update_of'));

CREATE TRIGGER reference_duplicate_questions_no_truncate BEFORE TRUNCATE ON reference_duplicate_questions FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
