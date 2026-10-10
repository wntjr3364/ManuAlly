-- PW-046 review MINOR 3: a new paragraph placed by default at the end of its plan's section remembers
-- that section's heading (and its hash). Applied, it goes after the section's end as it is then, so
-- several paragraphs of one section keep the order they are applied in; it turns STALE only when the
-- heading itself changes or goes (a paragraph edited inside the section does not matter).
ALTER TABLE paragraph_proposals
  ADD COLUMN section_heading_id uuid,
  ADD COLUMN section_heading_hash text CHECK (section_heading_hash IS NULL OR section_heading_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE paragraph_proposals ADD CONSTRAINT paragraph_proposals_section_heading CHECK ((section_heading_id IS NULL) = (section_heading_hash IS NULL));
ALTER TABLE paragraph_proposals ADD CONSTRAINT paragraph_proposals_section_heading_draft CHECK (section_heading_id IS NULL OR (mode = 'draft' AND after_block_id IS NOT NULL));
