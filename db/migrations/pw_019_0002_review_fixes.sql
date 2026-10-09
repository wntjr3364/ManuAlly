-- PW-019 review: a snapshot (later the submitted version) must render its citations and figure
-- numbers as they were. It now pins the citation style, the style version and the figure/table order.
-- (Correction to pw_019_0001's comment: the figure position index is checked immediately, not at
-- commit; reorderFigures moves positions out of the way first.)
ALTER TABLE paper_snapshots ADD COLUMN citation_style text CHECK (citation_style IS NULL OR citation_style IN ('numeric', 'author_year'));
ALTER TABLE paper_snapshots ADD COLUMN style_version text;

CREATE TABLE snapshot_figures (
  snapshot_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  figure_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('figure', 'table')),
  position integer NOT NULL CHECK (position >= 1),
  title text NOT NULL,
  PRIMARY KEY (snapshot_id, figure_id),
  FOREIGN KEY (paper_id, snapshot_id) REFERENCES paper_snapshots(paper_id, id),
  FOREIGN KEY (paper_id, figure_id) REFERENCES figure_objects(paper_id, id)
);
SELECT pw_make_immutable('snapshot_figures');
CREATE TRIGGER snapshot_figures_sealed AFTER INSERT ON snapshot_figures FOR EACH ROW EXECUTE FUNCTION pw_snapshot_sealed();
