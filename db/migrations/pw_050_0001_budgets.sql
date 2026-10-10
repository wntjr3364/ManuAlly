-- PW-050: cost reservation and budget guard (spec 08 "Budget").
-- budgets: the owner's limits in USD — for the whole app, one paper (with an optional per-run limit) or one
-- provider. A change is a new row; the latest row of a scope counts. Rows are never changed.
-- budget_reservations: one per admitted run of a job, with its cost class, the estimate it reserved (a
-- run that is charged per call needs one), and how it settled from the usage ledger. Paid overage and
-- reset credits are never part of a reservation. Only state and the settlement change, once.
-- job_limit_uses: per-job counters for bounded actions (repairs, searches).
CREATE TABLE budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  scope text NOT NULL CHECK (scope IN ('app', 'paper', 'provider')),
  paper_id uuid REFERENCES paper_projects(id),
  provider text CHECK (provider IS NULL OR provider IN ('mock', 'claude_agent', 'codex')),
  limit_usd numeric(12, 4) NOT NULL CHECK (limit_usd >= 0 AND limit_usd <= 100000),
  run_limit_usd numeric(12, 4) CHECK (run_limit_usd IS NULL OR run_limit_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope = 'paper') = (paper_id IS NOT NULL)),
  CHECK ((scope = 'provider') = (provider IS NOT NULL)),
  CHECK (run_limit_usd IS NULL OR scope = 'paper')
);
CREATE INDEX budgets_latest ON budgets (owner_id, scope, paper_id, provider, created_at DESC);
SELECT pw_make_immutable('budgets');

CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  paper_id uuid NOT NULL,
  job_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  provider text NOT NULL CHECK (provider IN ('mock', 'claude_agent', 'codex')),
  auth_mode text NOT NULL CHECK (char_length(auth_mode) BETWEEN 1 AND 60),
  cost_class text NOT NULL CHECK (cost_class IN ('free', 'subscription_included', 'metered')),
  estimate_usd numeric(12, 4) CHECK (estimate_usd IS NULL OR estimate_usd >= 0),
  paid_overage boolean NOT NULL DEFAULT false CHECK (NOT paid_overage),
  reset_credit boolean NOT NULL DEFAULT false CHECK (NOT reset_credit),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'released')),
  settled_usd numeric(12, 4) CHECK (settled_usd IS NULL OR settled_usd >= 0),
  settled_unknown boolean,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (job_id, fencing_token),
  FOREIGN KEY (paper_id, job_id) REFERENCES jobs(paper_id, id),
  CHECK (cost_class <> 'metered' OR estimate_usd IS NOT NULL),
  CHECK ((state = 'settled') = (settled_unknown IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX budget_reservations_owner ON budget_reservations (owner_id, cost_class, state);
CREATE FUNCTION pw_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: reservations are kept' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state <> 'reserved' OR (to_jsonb(NEW) - ARRAY['state', 'settled_usd', 'settled_unknown', 'settled_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'settled_usd', 'settled_unknown', 'settled_at']) THEN
    RAISE EXCEPTION 'immutable: a reservation settles once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budget_reservations_guard BEFORE UPDATE OR DELETE ON budget_reservations FOR EACH ROW EXECUTE FUNCTION pw_reservation_guard();
CREATE TRIGGER budget_reservations_no_truncate BEFORE TRUNCATE ON budget_reservations FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

CREATE TABLE job_limit_uses (
  job_id uuid NOT NULL REFERENCES jobs(id),
  kind text NOT NULL CHECK (kind IN ('repair', 'search')),
  used integer NOT NULL CHECK (used >= 1),
  PRIMARY KEY (job_id, kind)
);
