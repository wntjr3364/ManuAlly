-- PW-042: paragraph proposals from the Writer (spec 06 "ParagraphContract", "수정 모드"). A proposal is
-- made from one approved outline node's contract for one place in the manuscript: a new paragraph after
-- a block (draft), or a whole existing paragraph (conservative correction, scientific rewrite). Its
-- content, contract, checks and the base revision never change; only the owner's decision does
-- (PENDING -> APPLIED / REJECTED), or the system marks it STALE when the manuscript moved on.
CREATE TABLE paragraph_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  document_id uuid NOT NULL,
  base_revision_id uuid NOT NULL,
  outline_revision_id uuid NOT NULL,
  node_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('draft', 'conservative', 'rewrite')),
  -- draft: insert after this block (NULL = at the end); conservative/rewrite: this block, as it was
  after_block_id uuid,
  block_id uuid,
  expected_block_hash text CHECK (expected_block_hash IS NULL OR expected_block_hash ~ '^[0-9a-f]{64}$'),
  contract jsonb NOT NULL CHECK (jsonb_typeof(contract) = 'object'),
  contract_hash text NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  -- the paragraph block as it would be inserted (NULL when the writer reported missing evidence or no change)
  paragraph jsonb CHECK (paragraph IS NULL OR jsonb_typeof(paragraph) = 'object'),
  missing jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(missing) = 'array'),
  checks jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checks) = 'array'),
  warnings text[] NOT NULL DEFAULT '{}',
  claim_ids uuid[] NOT NULL DEFAULT '{}',
  fact_ids uuid[] NOT NULL DEFAULT '{}',
  generator text NOT NULL CHECK (generator IN ('mock', 'claude_agent', 'codex')),
  generator_label text CHECK (generator_label IS NULL OR char_length(generator_label) <= 40),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING', 'CHECK_FAILED', 'NEEDS_EVIDENCE', 'NO_CHANGE', 'STALE', 'APPLIED', 'REJECTED')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) <= 2000),
  applied_revision_id uuid REFERENCES document_revisions(id),
  new_block_id uuid,
  decided_by uuid REFERENCES owners(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((mode = 'draft') = (block_id IS NULL)),
  CHECK (mode = 'draft' OR after_block_id IS NULL),
  CHECK ((block_id IS NULL) = (expected_block_hash IS NULL)),
  CHECK ((status IN ('PENDING', 'CHECK_FAILED', 'APPLIED', 'REJECTED', 'STALE')) OR paragraph IS NULL),
  CHECK ((status = 'APPLIED') = (applied_revision_id IS NOT NULL AND new_block_id IS NOT NULL)),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id),
  FOREIGN KEY (paper_id, outline_revision_id) REFERENCES outline_revisions(paper_id, id),
  FOREIGN KEY (outline_revision_id, node_id) REFERENCES outline_nodes(outline_revision_id, node_id)
);
CREATE INDEX paragraph_proposals_document ON paragraph_proposals (paper_id, document_id, created_at DESC);

CREATE FUNCTION pw_042_paragraph_proposal_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR (to_jsonb(NEW) - 'status' - 'status_reason' - 'applied_revision_id' - 'new_block_id' - 'decided_by' - 'decided_at')
        <> (to_jsonb(OLD) - 'status' - 'status_reason' - 'applied_revision_id' - 'new_block_id' - 'decided_by' - 'decided_at')
     OR OLD.status <> 'PENDING' OR NEW.status NOT IN ('APPLIED', 'REJECTED', 'STALE') THEN
    RAISE EXCEPTION 'immutable: a paragraph proposal only moves PENDING -> APPLIED / REJECTED / STALE' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paragraph_proposals_status BEFORE UPDATE OR DELETE ON paragraph_proposals FOR EACH ROW EXECUTE FUNCTION pw_042_paragraph_proposal_status();
CREATE TRIGGER paragraph_proposals_no_truncate BEFORE TRUNCATE ON paragraph_proposals FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
