-- PW-029: usage ledger and quota observations (spec 08 "세 가지 제한을 분리", "Quota normalization").
-- usage_events: what a provider reported for a run, kept by scope (one message, one turn, the session
--   so far). Each report has a provider-unique event key, so a redelivered event is stored once.
--   Session-scope reports are cumulative: the stored delta is the increase over the session's previous
--   report; a decrease is an anomaly (delta NULL), never a negative cost. A value the provider did not
--   report stays NULL and is named in unknown_fields — never 0.
-- quota_observations: account-level limits as observed (provider, auth profile, model, bucket). A reset
--   time the provider did not give stays NULL; nothing invents one. Rows are never changed.
CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  job_id uuid REFERENCES jobs(id),
  provider text NOT NULL CHECK (provider IN ('mock', 'claude_agent', 'codex')),
  native_session_id text CHECK (native_session_id IS NULL OR char_length(native_session_id) BETWEEN 1 AND 200),
  model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 200),
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 300),
  scope text NOT NULL CHECK (scope IN ('message', 'turn', 'session')),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cost_usd_estimate numeric(14, 6) CHECK (cost_usd_estimate >= 0),
  context_window integer CHECK (context_window >= 1),
  unknown_fields text[] NOT NULL DEFAULT '{}',
  delta_input_tokens bigint CHECK (delta_input_tokens >= 0),
  delta_output_tokens bigint CHECK (delta_output_tokens >= 0),
  delta_cost_usd numeric(14, 6) CHECK (delta_cost_usd >= 0),
  anomaly text CHECK (anomaly IS NULL OR anomaly IN ('cumulative_decreased')),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, event_key),
  CHECK (scope = 'session' OR anomaly IS NULL)
);
CREATE INDEX usage_events_paper ON usage_events (paper_id, observed_at);
CREATE INDEX usage_events_session ON usage_events (provider, native_session_id, scope, observed_at, created_at);
SELECT pw_make_immutable('usage_events');

CREATE TABLE quota_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('mock', 'claude_agent', 'codex')),
  auth_profile_id text NOT NULL CHECK (auth_profile_id ~ '^[A-Za-z0-9._-]{1,100}$'),
  model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 200),
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 100),
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 300),
  status text NOT NULL CHECK (status IN ('allowed', 'warning', 'rejected', 'unknown')),
  used_percent numeric(6, 3) CHECK (used_percent BETWEEN 0 AND 100),
  resets_at timestamptz,
  raw_resets_at text CHECK (raw_resets_at IS NULL OR char_length(raw_resets_at) <= 100),
  unknown_reason text CHECK (unknown_reason IS NULL OR char_length(unknown_reason) <= 500),
  confidence text NOT NULL CHECK (confidence IN ('provider_reported', 'estimated', 'unknown')),
  retry_after_s integer CHECK (retry_after_s >= 0),
  error_kind text CHECK (error_kind IS NULL OR error_kind IN ('auth', 'quota', 'network', 'provider', 'unknown')),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, event_key),
  CHECK (resets_at IS NOT NULL OR unknown_reason IS NOT NULL)
);
CREATE INDEX quota_observations_latest ON quota_observations (provider, auth_profile_id, bucket, observed_at DESC);
SELECT pw_make_immutable('quota_observations');
