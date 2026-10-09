-- PW-037: assembled paragraph contexts, reused only for an identical fingerprint of every input
-- (document revision, paragraph, records and their states, permissions, policies, provider). Rows are
-- immutable: a change of any input is a different fingerprint, never an update of a cached context.
CREATE TABLE retrieval_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  document_id uuid NOT NULL,
  block_id text NOT NULL CHECK (char_length(block_id) BETWEEN 1 AND 100),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 50),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, document_id, block_id, provider, fingerprint),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id)
);
SELECT pw_make_immutable('retrieval_cache');
