-- PW-011 review fixes (M1, m2, m3, m5).

-- M1: the stored number equals the stored source text (which is kept exactly as written).
ALTER TABLE fact_records ADD CONSTRAINT fact_records_value_matches_text CHECK (value = value_text::numeric);
ALTER TABLE fact_statistics ADD CONSTRAINT fact_statistics_value_matches_text CHECK (value = value_text::numeric);

-- m2: a raw p-value has no adjustment method; an adjusted one is stored as adjusted_p_value.
ALTER TABLE fact_statistics ADD CONSTRAINT fact_statistics_raw_p_unadjusted CHECK (kind <> 'p_value' OR adjustment = '');

-- m5: the extraction method agrees with where the fact came from.
ALTER TABLE fact_records ADD CONSTRAINT fact_records_method_matches_origin CHECK ((origin = 'ai_extraction') = (extraction_method = 'ai_extraction'));

-- m3: review timestamps come from the server clock, never from the statement.
CREATE OR REPLACE FUNCTION pw_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text := TG_ARGV[0];
  by_col text := TG_ARGV[1];
  at_col text := TG_ARGV[2];
  pending text := TG_ARGV[3];
  done text := TG_ARGV[4];
  review_cols text[] := ARRAY[TG_ARGV[0], TG_ARGV[1], TG_ARGV[2], 'closed_at'];
  n jsonb;
  o jsonb;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  n := to_jsonb(NEW);
  IF TG_OP = 'INSERT' THEN
    IF n->>st <> pending OR n->>by_col IS NOT NULL OR n->>at_col IS NOT NULL OR n->>'closed_at' IS NOT NULL THEN
      RAISE EXCEPTION 'illegal review transition on %: new rows start as % with no reviewer', TG_TABLE_NAME, pending USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD);
  IF (n - review_cols) IS DISTINCT FROM (o - review_cols) THEN
    RAISE EXCEPTION 'immutable: % content cannot change', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF n->>st = o->>st THEN
    ok := n->by_col IS NOT DISTINCT FROM o->by_col AND n->at_col IS NOT DISTINCT FROM o->at_col AND n->'closed_at' IS NOT DISTINCT FROM o->'closed_at';
  ELSE
    ok := (o->>st = pending AND n->>st = done AND n->>by_col IS NOT NULL AND n->>at_col IS NOT NULL AND n->>'closed_at' IS NULL)
       OR (o->>st = pending AND n->>st = 'REJECTED' AND n->>by_col IS NULL AND n->>at_col IS NULL AND n->>'closed_at' IS NOT NULL)
       OR (o->>st = done AND n->>st = 'RETRACTED' AND n->by_col = o->by_col AND n->at_col = o->at_col AND n->>'closed_at' IS NOT NULL);
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'illegal review transition on %: % -> %', TG_TABLE_NAME, o->>st, n->>st USING ERRCODE = 'restrict_violation';
  END IF;
  IF n->>by_col IS NOT NULL AND (n->>by_col)::uuid IS DISTINCT FROM (SELECT owner_id FROM paper_projects WHERE id = NEW.paper_id) THEN
    RAISE EXCEPTION 'illegal review transition on %: the reviewer must be the paper owner', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  -- stamp the time of the transition itself
  IF n->>st IS DISTINCT FROM o->>st THEN
    IF n->>st = done THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object(at_col, clock_timestamp()));
    ELSE
      NEW := jsonb_populate_record(NEW, jsonb_build_object('closed_at', clock_timestamp()));
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- m3: an observation claim is approved only with verified evidence that supports it (also in SQL).
CREATE FUNCTION pw_observation_needs_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'observation' AND NEW.approval_state = 'APPROVED' AND OLD.approval_state <> 'APPROVED'
     AND NOT EXISTS (SELECT 1 FROM claim_evidence_links l JOIN evidence_records e ON e.id = l.evidence_id
                     WHERE l.claim_id = NEW.id AND l.relation = 'supports' AND e.extraction_state = 'VERIFIED') THEN
    RAISE EXCEPTION 'illegal review transition on claims: an observation needs verified supporting evidence' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claims_observation_evidence BEFORE UPDATE ON claims FOR EACH ROW EXECUTE FUNCTION pw_observation_needs_evidence();
