-- PW-010: story and outline revisions with explicit, exact approval.
-- Content of a revision never changes. Only the status moves, and only forward:
--   DRAFT -> IN_REVIEW -> APPROVED -> SUPERSEDED   (DRAFT -> APPROVED and IN_REVIEW -> DRAFT allowed)
-- APPROVED requires approved_by/approved_at; nothing is ever deleted.

CREATE TABLE story_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  parent_revision_id uuid,
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
  story jsonb NOT NULL CHECK (jsonb_typeof(story) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by uuid REFERENCES owners(id),
  approved_at timestamptz,
  superseded_at timestamptz,
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, parent_revision_id) REFERENCES story_revisions(paper_id, id),
  CHECK ((status IN ('APPROVED', 'SUPERSEDED')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
-- only one "latest" child per parent: concurrent saves on the same parent cannot both succeed
CREATE UNIQUE INDEX story_revisions_one_child ON story_revisions (paper_id, coalesce(parent_revision_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- at most one approved (active) story per paper
CREATE UNIQUE INDEX story_revisions_one_approved ON story_revisions (paper_id) WHERE status = 'APPROVED';

CREATE TABLE outline_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  story_revision_id uuid NOT NULL,
  parent_revision_id uuid,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by uuid REFERENCES owners(id),
  approved_at timestamptz,
  superseded_at timestamptz,
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, story_revision_id) REFERENCES story_revisions(paper_id, id),
  FOREIGN KEY (paper_id, parent_revision_id) REFERENCES outline_revisions(paper_id, id),
  CHECK ((status IN ('APPROVED', 'SUPERSEDED')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX outline_revisions_one_child ON outline_revisions (paper_id, coalesce(parent_revision_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE UNIQUE INDEX outline_revisions_one_approved ON outline_revisions (paper_id) WHERE status = 'APPROVED';

CREATE TABLE outline_nodes (
  outline_revision_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  node_id uuid NOT NULL,                 -- stable across outline revisions
  parent_node_id uuid,
  position integer NOT NULL CHECK (position >= 0),
  section text NOT NULL CHECK (length(section) BETWEEN 1 AND 120),
  role text NOT NULL CHECK (role IN ('background', 'gap', 'aim', 'method', 'result', 'interpretation', 'comparison', 'limitation', 'conclusion', 'other')),
  paragraph_goal text NOT NULL CHECK (length(btrim(paragraph_goal)) BETWEEN 1 AND 2000),
  claim_ids text[] NOT NULL DEFAULT '{}',
  evidence_ids text[] NOT NULL DEFAULT '{}',
  requires_evidence boolean NOT NULL DEFAULT false,
  allowed_interpretation text NOT NULL DEFAULT '',
  exclusions text[] NOT NULL DEFAULT '{}',
  transition text NOT NULL DEFAULT '',
  word_budget_min integer CHECK (word_budget_min IS NULL OR word_budget_min >= 0),
  word_budget_max integer CHECK (word_budget_max IS NULL OR word_budget_max >= coalesce(word_budget_min, 0)),
  PRIMARY KEY (outline_revision_id, node_id),
  UNIQUE (outline_revision_id, position),
  FOREIGN KEY (paper_id, outline_revision_id) REFERENCES outline_revisions(paper_id, id),
  FOREIGN KEY (outline_revision_id, parent_node_id) REFERENCES outline_nodes(outline_revision_id, node_id)
);
SELECT pw_make_immutable('outline_nodes');

CREATE TABLE outline_node_approvals (
  outline_revision_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  node_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid NOT NULL REFERENCES owners(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (outline_revision_id, node_id),
  FOREIGN KEY (paper_id, outline_revision_id) REFERENCES outline_revisions(paper_id, id),
  FOREIGN KEY (outline_revision_id, node_id) REFERENCES outline_nodes(outline_revision_id, node_id)
);
SELECT pw_make_immutable('outline_node_approvals');

-- content immutable, status forward-only, no deletes (story and outline revisions)
CREATE FUNCTION pw_revision_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approved_by', 'approved_at', 'superseded_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approved_by', 'approved_at', 'superseded_at']) THEN
    RAISE EXCEPTION 'immutable: % content cannot change', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  ok := NEW.status = OLD.status AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at AND NEW.superseded_at IS NOT DISTINCT FROM OLD.superseded_at
     OR (OLD.status = 'DRAFT' AND NEW.status = 'IN_REVIEW')
     OR (OLD.status = 'IN_REVIEW' AND NEW.status = 'DRAFT')
     OR (OLD.status IN ('DRAFT', 'IN_REVIEW') AND NEW.status = 'APPROVED' AND NEW.approved_by IS NOT NULL AND NEW.approved_at IS NOT NULL)
     OR (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED' AND NEW.approved_by = OLD.approved_by AND NEW.approved_at = OLD.approved_at AND NEW.superseded_at IS NOT NULL);
  IF NOT ok THEN
    RAISE EXCEPTION 'illegal status transition on %: % -> %', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER story_revisions_guard BEFORE UPDATE OR DELETE ON story_revisions FOR EACH ROW EXECUTE FUNCTION pw_revision_status_guard();
CREATE TRIGGER story_revisions_no_truncate BEFORE TRUNCATE ON story_revisions FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
CREATE TRIGGER outline_revisions_guard BEFORE UPDATE OR DELETE ON outline_revisions FOR EACH ROW EXECUTE FUNCTION pw_revision_status_guard();
CREATE TRIGGER outline_revisions_no_truncate BEFORE TRUNCATE ON outline_revisions FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

-- the paper's active (user-selected, approved) story and outline
ALTER TABLE paper_projects
  ADD COLUMN active_story_revision_id uuid,
  ADD COLUMN active_outline_revision_id uuid,
  ADD CONSTRAINT paper_active_story_fk FOREIGN KEY (id, active_story_revision_id) REFERENCES story_revisions(paper_id, id),
  ADD CONSTRAINT paper_active_outline_fk FOREIGN KEY (id, active_outline_revision_id) REFERENCES outline_revisions(paper_id, id);

-- snapshots also pin the active story/outline (PW-009 left these for this task)
ALTER TABLE paper_snapshots
  ADD COLUMN story_revision_id uuid,
  ADD COLUMN outline_revision_id uuid,
  ADD CONSTRAINT snapshot_story_fk FOREIGN KEY (paper_id, story_revision_id) REFERENCES story_revisions(paper_id, id),
  ADD CONSTRAINT snapshot_outline_fk FOREIGN KEY (paper_id, outline_revision_id) REFERENCES outline_revisions(paper_id, id);

-- the active pointers can only name an approved revision
CREATE FUNCTION pw_active_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_story_revision_id IS DISTINCT FROM OLD.active_story_revision_id AND NEW.active_story_revision_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM story_revisions WHERE id = NEW.active_story_revision_id AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'illegal active story transition: revision is not approved' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.active_outline_revision_id IS DISTINCT FROM OLD.active_outline_revision_id AND NEW.active_outline_revision_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM outline_revisions WHERE id = NEW.active_outline_revision_id AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'illegal active outline transition: revision is not approved' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paper_active_revision_guard BEFORE UPDATE OF active_story_revision_id, active_outline_revision_id ON paper_projects
  FOR EACH ROW EXECUTE FUNCTION pw_active_revision_guard();
