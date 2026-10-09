-- PW-037 review: retrieval_cache keeps a record of assembled contexts (never served in place of a fresh
-- one). Rows may be pruned (the latest few per paragraph and provider are kept) but never changed.
DROP TRIGGER retrieval_cache_immutable_row ON retrieval_cache;
CREATE FUNCTION pw_037_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable: retrieval records cannot be changed (only pruned)' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER retrieval_cache_no_update BEFORE UPDATE ON retrieval_cache FOR EACH ROW EXECUTE FUNCTION pw_037_no_update();
CREATE INDEX retrieval_cache_paragraph ON retrieval_cache (paper_id, document_id, block_id, provider, created_at DESC);
