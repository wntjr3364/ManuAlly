-- PW-009 review fixes (M1–M3).
-- M1: a snapshot's manifest is written only in the transaction that created the snapshot.
-- AFTER triggers so a cross-paper row still reports its foreign-key violation first (RI_* triggers sort first).
ALTER TABLE paper_snapshots ADD COLUMN created_xid xid8 NOT NULL DEFAULT pg_current_xact_id();

CREATE FUNCTION pw_snapshot_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM paper_snapshots WHERE id = NEW.snapshot_id AND created_xid = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'immutable: snapshot % is sealed; its manifest cannot gain rows', NEW.snapshot_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER snapshot_document_revisions_sealed AFTER INSERT ON snapshot_document_revisions FOR EACH ROW EXECUTE FUNCTION pw_snapshot_sealed();
CREATE TRIGGER snapshot_reference_revisions_sealed AFTER INSERT ON snapshot_reference_revisions FOR EACH ROW EXECUTE FUNCTION pw_snapshot_sealed();
CREATE TRIGGER snapshot_asset_revisions_sealed AFTER INSERT ON snapshot_asset_revisions FOR EACH ROW EXECUTE FUNCTION pw_snapshot_sealed();

-- M2: a paper can only link references of its own owner.
ALTER TABLE project_references ADD COLUMN owner_id uuid;
UPDATE project_references pr SET owner_id = p.owner_id FROM paper_projects p WHERE p.id = pr.paper_id;
ALTER TABLE project_references
  ALTER COLUMN owner_id SET NOT NULL,
  ADD CONSTRAINT project_references_paper_owner_fk FOREIGN KEY (paper_id, owner_id) REFERENCES paper_projects(id, owner_id),
  ADD CONSTRAINT project_references_reference_owner_fk FOREIGN KEY (owner_id, reference_id) REFERENCES reference_works(owner_id, id);

-- M3: membership is removed softly, so snapshots that pinned a reference keep their link.
ALTER TABLE project_references ADD COLUMN removed_at timestamptz;
CREATE FUNCTION pw_project_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: remove a reference from a paper by setting removed_at' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.paper_id, NEW.reference_id, NEW.owner_id, NEW.added_at) IS DISTINCT FROM (OLD.paper_id, OLD.reference_id, OLD.owner_id, OLD.added_at) THEN
    RAISE EXCEPTION 'immutable: project reference identity cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_references_guard BEFORE UPDATE OR DELETE ON project_references FOR EACH ROW EXECUTE FUNCTION pw_project_reference_guard();
CREATE TRIGGER project_references_no_truncate BEFORE TRUNCATE ON project_references FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
