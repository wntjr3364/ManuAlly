-- PW-017: selection handles, edit proposals and idempotent apply (spec 04 "AI proposal 경로").
-- Rules enforced here (not only in the API):
--   * a selection handle is immutable and points at a stored revision of the same document
--   * a proposal is created PENDING (or already CHECK_FAILED / STALE); its content never changes;
--     only PENDING -> APPLIED | REJECTED | STALE, stamped with the database clock
--   * APPLIED <-> applied_revision_id; a pre-approval proposal (RFC-003) has no outline revision and
--     may only be a conservative correction (grammar, concise)
--   * an apply request key maps to exactly one result, forever (idempotent apply)

CREATE TABLE selection_handles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  document_id uuid NOT NULL,
  base_revision_id uuid NOT NULL,
  block_id uuid NOT NULL,
  from_pos integer NOT NULL CHECK (from_pos >= 0),
  to_pos integer NOT NULL,
  expected_block_hash text NOT NULL CHECK (expected_block_hash ~ '^[0-9a-f]{64}$'),
  selected_slice_hash text NOT NULL CHECK (selected_slice_hash ~ '^[0-9a-f]{64}$'),
  quote text NOT NULL,
  atoms jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(atoms) = 'array'),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (to_pos > from_pos),
  UNIQUE (paper_id, id),
  UNIQUE (paper_id, document_id, id),
  FOREIGN KEY (paper_id, document_id, base_revision_id) REFERENCES document_revisions(paper_id, document_id, id)
);
CREATE INDEX selection_handles_doc ON selection_handles (document_id, created_at DESC);
SELECT pw_make_immutable('selection_handles');

CREATE TABLE edit_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  document_id uuid NOT NULL,
  selection_handle_id uuid NOT NULL,
  base_revision_id uuid NOT NULL,
  outline_revision_id uuid,
  intent text NOT NULL CHECK (intent IN ('grammar', 'concise', 'rewrite')),
  mode text NOT NULL CHECK (mode IN ('preapproval', 'approved_outline')),
  replacement jsonb NOT NULL CHECK (jsonb_typeof(replacement) = 'array'),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object'),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  explanation text CHECK (explanation IS NULL OR length(explanation) <= 4000),
  origin text NOT NULL CHECK (origin ~ '^(owner|worker|system):[A-Za-z0-9._:-]{1,200}$'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED', 'STALE', 'CHECK_FAILED')),
  status_reason text,
  applied_revision_id uuid,
  decided_by uuid REFERENCES owners(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, document_id, selection_handle_id) REFERENCES selection_handles(paper_id, document_id, id),
  FOREIGN KEY (paper_id, document_id, base_revision_id) REFERENCES document_revisions(paper_id, document_id, id),
  FOREIGN KEY (paper_id, document_id, applied_revision_id) REFERENCES document_revisions(paper_id, document_id, id),
  FOREIGN KEY (paper_id, outline_revision_id) REFERENCES outline_revisions(paper_id, id),
  CHECK ((mode = 'preapproval') = (outline_revision_id IS NULL)),
  CHECK (mode = 'approved_outline' OR intent IN ('grammar', 'concise')),
  CHECK ((status = 'APPLIED') = (applied_revision_id IS NOT NULL)),
  CHECK ((status IN ('APPLIED', 'REJECTED')) = (decided_by IS NOT NULL))
);
CREATE INDEX edit_proposals_doc ON edit_proposals (document_id, status, created_at DESC);
-- a revision is the result of at most one proposal
CREATE UNIQUE INDEX edit_proposals_one_result ON edit_proposals (applied_revision_id) WHERE applied_revision_id IS NOT NULL;

CREATE FUNCTION pw_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: edit_proposals rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'CHECK_FAILED', 'STALE') THEN
      RAISE EXCEPTION 'a proposal is created PENDING, CHECK_FAILED or STALE, not %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.decided_at := CASE WHEN NEW.status = 'PENDING' THEN NULL ELSE clock_timestamp() END;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'status_reason', 'applied_revision_id', 'decided_by', 'decided_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'status_reason', 'applied_revision_id', 'decided_by', 'decided_at']) THEN
    RAISE EXCEPTION 'immutable: a proposal''s content cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'PENDING' OR NEW.status NOT IN ('APPLIED', 'REJECTED', 'STALE') THEN
      RAISE EXCEPTION 'proposal status % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.decided_at := clock_timestamp();
  ELSIF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'a decided proposal cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER edit_proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON edit_proposals FOR EACH ROW EXECUTE FUNCTION pw_proposal_guard();
CREATE TRIGGER edit_proposals_no_truncate BEFORE TRUNCATE ON edit_proposals FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
CREATE TRIGGER edit_proposals_audit AFTER INSERT OR UPDATE ON edit_proposals FOR EACH ROW EXECUTE FUNCTION pw_audit_state('edit_proposal', 'status');

CREATE TABLE proposal_applies (
  paper_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  proposal_id uuid NOT NULL,
  document_id uuid NOT NULL,
  result_revision_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (paper_id, idempotency_key),
  FOREIGN KEY (paper_id, proposal_id) REFERENCES edit_proposals(paper_id, id),
  FOREIGN KEY (paper_id, document_id, result_revision_id) REFERENCES document_revisions(paper_id, document_id, id)
);
SELECT pw_make_immutable('proposal_applies');
