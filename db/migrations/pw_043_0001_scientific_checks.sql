-- PW-043: runs of the deterministic scientific gate on a manuscript paragraph (spec 06 "검증 층" A).
-- Each run records the exact revision and block it read, the gate version, the overall status and
-- every finding with its fact/reference and evidence locator. Never changed afterwards.
CREATE TABLE scientific_check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL REFERENCES document_revisions(id),
  block_id uuid NOT NULL,
  gate_version text NOT NULL CHECK (char_length(gate_version) BETWEEN 1 AND 40),
  status text NOT NULL CHECK (status IN ('VERIFIED', 'FAILED', 'UNKNOWN', 'NOT_APPLICABLE')),
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id)
);
CREATE INDEX scientific_check_runs_block ON scientific_check_runs (paper_id, document_id, block_id, created_at DESC);
SELECT pw_make_immutable('scientific_check_runs');
