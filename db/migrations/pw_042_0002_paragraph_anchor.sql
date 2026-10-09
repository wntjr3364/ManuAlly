-- PW-042 review MINOR 3: a new paragraph is tied to the block it follows as it was (its hash), so the
-- proposal stays applicable while the rest of the manuscript changes, and turns STALE only when that
-- block changes or goes.
ALTER TABLE paragraph_proposals ADD COLUMN after_block_hash text CHECK (after_block_hash IS NULL OR after_block_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE paragraph_proposals ADD CONSTRAINT paragraph_proposals_after_hash CHECK ((after_block_id IS NULL) = (after_block_hash IS NULL));
