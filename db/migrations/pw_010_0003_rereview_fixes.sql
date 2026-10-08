-- PW-010 re-review fixes (m1, m2, m4).

-- m2: refuse to continue if an active pointer already names a revision that is not approved
-- (possible only through direct SQL before pw_010_0002). Fix the data explicitly; never silently.
DO $$
DECLARE
  bad uuid;
BEGIN
  SELECT p.id INTO bad FROM paper_projects p
    LEFT JOIN story_revisions s ON s.id = p.active_story_revision_id
    LEFT JOIN outline_revisions o ON o.id = p.active_outline_revision_id
    WHERE (p.active_story_revision_id IS NOT NULL AND s.status <> 'APPROVED')
       OR (p.active_outline_revision_id IS NOT NULL AND o.status <> 'APPROVED')
    LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'paper % has an active story/outline pointer to a revision that is not approved; clear it (UPDATE paper_projects SET active_..._revision_id = NULL) and re-approve before migrating', bad;
  END IF;
END $$;

-- m1: lock the named revision rows, so a concurrent supersede and pointer move serialize and the
-- later one re-checks against the committed status.
CREATE OR REPLACE FUNCTION pw_active_pointers_approved() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad uuid;
  st text;
BEGIN
  IF TG_TABLE_NAME = 'paper_projects' THEN
    SELECT active_story_revision_id, active_outline_revision_id INTO NEW.active_story_revision_id, NEW.active_outline_revision_id
      FROM paper_projects WHERE id = NEW.id;
    IF NEW.active_story_revision_id IS NOT NULL THEN
      SELECT status INTO st FROM story_revisions WHERE id = NEW.active_story_revision_id FOR SHARE;
      IF st IS DISTINCT FROM 'APPROVED' THEN bad := NEW.id; END IF;
    END IF;
    IF NEW.active_outline_revision_id IS NOT NULL THEN
      SELECT status INTO st FROM outline_revisions WHERE id = NEW.active_outline_revision_id FOR SHARE;
      IF st IS DISTINCT FROM 'APPROVED' THEN bad := NEW.id; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'story_revisions' THEN
    SELECT p.id INTO bad FROM paper_projects p JOIN story_revisions s ON s.id = p.active_story_revision_id
      WHERE s.id = NEW.id AND s.status <> 'APPROVED' FOR SHARE OF p;
  ELSE
    SELECT p.id INTO bad FROM paper_projects p JOIN outline_revisions o ON o.id = p.active_outline_revision_id
      WHERE o.id = NEW.id AND o.status <> 'APPROVED' FOR SHARE OF p;
  END IF;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'illegal active revision transition: paper % would point at a revision that is not approved', bad USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;

-- m4: a blank id is not a claim or evidence reference.
CREATE FUNCTION pw_no_blank(a text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS
  $$ SELECT NOT EXISTS (SELECT 1 FROM unnest(a) e WHERE btrim(e) = '') $$;
ALTER TABLE outline_nodes
  ADD CONSTRAINT outline_nodes_evidence_not_blank CHECK (pw_no_blank(evidence_ids)),
  ADD CONSTRAINT outline_nodes_claims_not_blank CHECK (pw_no_blank(claim_ids));
