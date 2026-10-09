-- PW-018 re-review: an anchor records which near side (12 characters before / after the quote) was
-- unique in its paragraph when the comment was made; only such a side is evidence later. Anchors made
-- before this migration have neither (false): they stay attached only with their full surroundings.
ALTER TABLE comment_anchors
  ADD COLUMN near_before_unique boolean NOT NULL DEFAULT false,
  ADD COLUMN near_after_unique boolean NOT NULL DEFAULT false;
