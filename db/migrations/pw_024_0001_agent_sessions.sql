-- PW-024: session bindings (spec 07 "세션 식별"). The native session id a provider run used, recorded
-- per paper and work thread with the provider version, auth profile and the run's folders. A later turn
-- resumes only the id found here for the same paper, thread, provider version and auth profile — never
-- the provider's "latest" session or a folder-based guess. Rows are never changed.
CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  work_thread text NOT NULL CHECK (work_thread ~ '^[a-z0-9][a-z0-9:_-]{0,199}$'),
  provider text NOT NULL CHECK (provider IN ('claude_agent', 'codex')),
  provider_version text NOT NULL CHECK (char_length(provider_version) BETWEEN 1 AND 100),
  auth_profile_id text NOT NULL CHECK (auth_profile_id ~ '^[A-Za-z0-9._-]{1,100}$'),
  native_session_id text NOT NULL CHECK (native_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  run_state_dir text NOT NULL CHECK (char_length(run_state_dir) BETWEEN 1 AND 1000),
  cwd text NOT NULL CHECK (char_length(cwd) BETWEEN 1 AND 1000),
  capability_snapshot jsonb NOT NULL CHECK (jsonb_typeof(capability_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, native_session_id)
);
CREATE INDEX agent_sessions_lookup ON agent_sessions (paper_id, work_thread, provider, provider_version, auth_profile_id, created_at DESC);
SELECT pw_make_immutable('agent_sessions');
