-- PW-019: what citations and cross-references point at.
--   * the paper's citation style (labels and bibliography are computed, never stored as text)
--   * figure/table objects with stable ids and a user-set order (numbers are computed from the order)
-- References themselves use the PW-009 tables (reference_works, immutable bibliographic_revisions,
-- project_references); a reference is created only from structured fields by the owner.

ALTER TABLE paper_projects ADD COLUMN citation_style text NOT NULL DEFAULT 'numeric' CHECK (citation_style IN ('numeric', 'author_year'));

CREATE TABLE figure_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  kind text NOT NULL CHECK (kind IN ('figure', 'table')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  position integer NOT NULL CHECK (position >= 1),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  UNIQUE (paper_id, id)
);
-- one figure per place among the live figures of a kind (checked at commit, so reordering can swap)
CREATE UNIQUE INDEX figure_objects_position ON figure_objects (paper_id, kind, position) WHERE archived_at IS NULL;

CREATE FUNCTION pw_figure_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: archive a figure instead of deleting it (references to it must stay explainable)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.paper_id, NEW.kind, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.paper_id, OLD.kind, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable: a figure keeps its identity and kind' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER figure_objects_guard BEFORE UPDATE OR DELETE ON figure_objects FOR EACH ROW EXECUTE FUNCTION pw_figure_object_guard();
CREATE TRIGGER figure_objects_no_truncate BEFORE TRUNCATE ON figure_objects FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
