-- PW-027: the typed tool gateway's run tokens and call audit (spec 07 "Tool gateway").
-- A run token binds one provider run to one owner, paper and document, the selection handles the run
-- may edit and the tools it may call. Only the token's SHA-256 is stored; the token itself never
-- enters the sandbox (the gateway socket holds it). A token can only be revoked, never widened.
CREATE TABLE agent_run_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  owner_id uuid NOT NULL REFERENCES owners(id),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  document_id uuid,
  handle_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(handle_ids) <= 50),
  tools text[] NOT NULL CHECK (cardinality(tools) BETWEEN 1 AND 20),
  provider text NOT NULL CHECK (provider IN ('claude_agent', 'codex', 'mock')),
  job_id uuid,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents (paper_id, id)
);
CREATE INDEX agent_run_tokens_paper ON agent_run_tokens (paper_id, created_at DESC);

-- only revocation (revoked_at from NULL to a time) may change a token row; nothing is deleted
CREATE FUNCTION pw_027_token_revoke_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (to_jsonb(NEW) - 'revoked_at') <> (to_jsonb(OLD) - 'revoked_at') THEN
    RAISE EXCEPTION 'agent_run_tokens rows are immutable except revocation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_run_tokens_revoke_only BEFORE UPDATE OR DELETE ON agent_run_tokens FOR EACH ROW EXECUTE FUNCTION pw_027_token_revoke_only();
CREATE TRIGGER agent_run_tokens_no_truncate BEFORE TRUNCATE ON agent_run_tokens FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

-- every gateway call: which token, which tool, the outcome, and a hash of the arguments (not the
-- arguments: they may hold manuscript text)
CREATE TABLE agent_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid REFERENCES agent_run_tokens(id),
  tool text NOT NULL CHECK (char_length(tool) BETWEEN 1 AND 100),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'refused', 'error')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 100),
  args_sha256 text NOT NULL CHECK (args_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_tool_calls_token ON agent_tool_calls (token_id, created_at);
SELECT pw_make_immutable('agent_tool_calls');
