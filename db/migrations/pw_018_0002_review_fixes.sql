-- PW-018 review: an anchor records the identity of the inline atoms in its quote (a citation replaced
-- by another one is not the same text). Existing anchors get none recorded: they keep the old rule
-- that a placeholder matches any atom only if they had no atoms; with atoms they will compare unequal
-- and become ORPHANED until attached again, which is the safe direction.
ALTER TABLE comment_anchors ADD COLUMN atoms jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(atoms) = 'array');
