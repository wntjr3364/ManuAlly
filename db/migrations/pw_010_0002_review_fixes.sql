-- PW-010 review fixes (A-M1, A-M2, A-m1) and PW-009 B-m1.

-- B-m1: created_xid is always the inserting transaction (a DEFAULT alone can be overridden).
CREATE FUNCTION pw_stamp_created_xid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_xid := pg_current_xact_id();
  RETURN NEW;
END $$;
CREATE TRIGGER paper_snapshots_stamp_xid BEFORE INSERT ON paper_snapshots FOR EACH ROW EXECUTE FUNCTION pw_stamp_created_xid();

-- A-M2: outline nodes are written only in the transaction that created their outline revision.
ALTER TABLE outline_revisions ADD COLUMN created_xid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE TRIGGER outline_revisions_stamp_xid BEFORE INSERT ON outline_revisions FOR EACH ROW EXECUTE FUNCTION pw_stamp_created_xid();
CREATE FUNCTION pw_outline_nodes_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM outline_revisions WHERE id = NEW.outline_revision_id AND created_xid = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'immutable: outline revision % is sealed; it cannot gain nodes', NEW.outline_revision_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER outline_nodes_sealed AFTER INSERT ON outline_nodes FOR EACH ROW EXECUTE FUNCTION pw_outline_nodes_sealed();

-- A-M2: a node approval carries the hash of the revision it approves, only while that revision is
-- under review, and never for a node that needs evidence and has none.
ALTER TABLE outline_revisions ADD CONSTRAINT outline_revisions_id_hash UNIQUE (id, content_hash);
ALTER TABLE outline_node_approvals ADD CONSTRAINT outline_node_approvals_hash_fk
  FOREIGN KEY (outline_revision_id, content_hash) REFERENCES outline_revisions(id, content_hash);
CREATE FUNCTION pw_outline_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM outline_revisions WHERE id = NEW.outline_revision_id AND status IN ('DRAFT', 'IN_REVIEW')) THEN
    RAISE EXCEPTION 'immutable: outline revision % is not under review; its approvals are final', NEW.outline_revision_id USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM outline_nodes WHERE outline_revision_id = NEW.outline_revision_id AND node_id = NEW.node_id
             AND requires_evidence AND cardinality(evidence_ids) = 0) THEN
    RAISE EXCEPTION 'illegal approval transition: node % needs evidence', NEW.node_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER outline_node_approvals_guard AFTER INSERT ON outline_node_approvals FOR EACH ROW EXECUTE FUNCTION pw_outline_approval_guard();

-- A-m1: consistent approval columns; revisions are born as drafts.
ALTER TABLE story_revisions
  ADD CONSTRAINT story_revisions_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT story_revisions_superseded_pair CHECK ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL));
ALTER TABLE outline_revisions
  ADD CONSTRAINT outline_revisions_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT outline_revisions_superseded_pair CHECK ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL));
CREATE FUNCTION pw_revision_born_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'DRAFT' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'illegal status transition on %: new revisions start as DRAFT', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER story_revisions_born_draft BEFORE INSERT ON story_revisions FOR EACH ROW EXECUTE FUNCTION pw_revision_born_draft();
CREATE TRIGGER outline_revisions_born_draft BEFORE INSERT ON outline_revisions FOR EACH ROW EXECUTE FUNCTION pw_revision_born_draft();

-- A-m1: DRAFT <-> IN_REVIEW must not touch the approval columns.
CREATE OR REPLACE FUNCTION pw_revision_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok boolean;
  same_approval boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approved_by', 'approved_at', 'superseded_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approved_by', 'approved_at', 'superseded_at']) THEN
    RAISE EXCEPTION 'immutable: % content cannot change', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  same_approval := NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at;
  ok := (NEW.status = OLD.status AND same_approval AND NEW.superseded_at IS NOT DISTINCT FROM OLD.superseded_at)
     OR (OLD.status = 'DRAFT' AND NEW.status = 'IN_REVIEW' AND same_approval AND NEW.superseded_at IS NULL)
     OR (OLD.status = 'IN_REVIEW' AND NEW.status = 'DRAFT' AND same_approval AND NEW.superseded_at IS NULL)
     OR (OLD.status IN ('DRAFT', 'IN_REVIEW') AND NEW.status = 'APPROVED' AND NEW.approved_by IS NOT NULL AND NEW.approved_at IS NOT NULL AND NEW.superseded_at IS NULL)
     OR (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED' AND same_approval AND NEW.superseded_at IS NOT NULL);
  IF NOT ok THEN
    RAISE EXCEPTION 'illegal status transition on %: % -> %', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- A-M1: at commit, every non-null active pointer names an APPROVED revision. Deferred, because
-- approval supersedes the previous revision before it moves the pointer.
CREATE FUNCTION pw_active_pointers_approved() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad uuid;
BEGIN
  IF TG_TABLE_NAME = 'paper_projects' THEN
    SELECT p.id INTO bad FROM paper_projects p
      LEFT JOIN story_revisions s ON s.id = p.active_story_revision_id
      LEFT JOIN outline_revisions o ON o.id = p.active_outline_revision_id
      WHERE p.id = NEW.id AND ((p.active_story_revision_id IS NOT NULL AND s.status IS DISTINCT FROM 'APPROVED')
                            OR (p.active_outline_revision_id IS NOT NULL AND o.status IS DISTINCT FROM 'APPROVED'));
  ELSIF TG_TABLE_NAME = 'story_revisions' THEN
    SELECT p.id INTO bad FROM paper_projects p JOIN story_revisions s ON s.id = p.active_story_revision_id
      WHERE s.id = NEW.id AND s.status <> 'APPROVED';
  ELSE
    SELECT p.id INTO bad FROM paper_projects p JOIN outline_revisions o ON o.id = p.active_outline_revision_id
      WHERE o.id = NEW.id AND o.status <> 'APPROVED';
  END IF;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'illegal active revision transition: paper % would point at a revision that is not approved', bad USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER paper_active_pointers_approved AFTER INSERT OR UPDATE ON paper_projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pw_active_pointers_approved();
CREATE CONSTRAINT TRIGGER story_active_pointers_approved AFTER UPDATE ON story_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pw_active_pointers_approved();
CREATE CONSTRAINT TRIGGER outline_active_pointers_approved AFTER UPDATE ON outline_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pw_active_pointers_approved();
