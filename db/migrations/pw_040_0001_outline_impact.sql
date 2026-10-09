-- PW-040: change impact on outline nodes (spec 03 "변경 영향"). Impacts are derived from the current
-- state of the sources a node relies on (claims, evidence, facts, figures, cited works); what is stored
-- is the owner's review of each one (immutable) and which manuscript paragraphs belong to a node.
CREATE TABLE outline_impact_resolutions (
  paper_id uuid NOT NULL,
  outline_revision_id uuid NOT NULL,
  node_id uuid NOT NULL,
  impact_key text NOT NULL CHECK (char_length(impact_key) BETWEEN 1 AND 300),
  resolution text NOT NULL CHECK (resolution IN ('reviewed')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  resolved_by uuid NOT NULL REFERENCES owners(id),
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (outline_revision_id, node_id, impact_key),
  FOREIGN KEY (outline_revision_id, node_id) REFERENCES outline_nodes(outline_revision_id, node_id),
  FOREIGN KEY (paper_id, outline_revision_id) REFERENCES outline_revisions(paper_id, id)
);
SELECT pw_make_immutable('outline_impact_resolutions');

CREATE TABLE outline_node_paragraphs (
  paper_id uuid NOT NULL,
  outline_revision_id uuid NOT NULL,
  node_id uuid NOT NULL,
  document_id uuid NOT NULL,
  block_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('user', 'draft')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (outline_revision_id, node_id, document_id, block_id),
  FOREIGN KEY (outline_revision_id, node_id) REFERENCES outline_nodes(outline_revision_id, node_id),
  FOREIGN KEY (paper_id, outline_revision_id) REFERENCES outline_revisions(paper_id, id),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id)
);
CREATE INDEX outline_node_paragraphs_block ON outline_node_paragraphs (paper_id, document_id, block_id);
