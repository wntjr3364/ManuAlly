-- PW-061: operations controls of one installation (spec 12 "비상 중단", "Disk pressure").
-- ops_controls: one row. ai_paused stops AI work (queued jobs wait; a running job's result is not applied and
-- the job runs again after resume); manual editing is never affected. disk_pressure is set by the supervisor
-- when the data root reaches its size cap: new uploads are refused until it clears.
-- ops_control_log: every change, who made it (the operator command) and why; never changed or deleted.
CREATE TABLE ops_controls (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  ai_paused boolean NOT NULL DEFAULT false,
  ai_reason text CHECK (ai_reason IS NULL OR length(ai_reason) BETWEEN 1 AND 500),
  ai_changed_at timestamptz,
  disk_pressure boolean NOT NULL DEFAULT false,
  disk_used_bytes bigint CHECK (disk_used_bytes IS NULL OR disk_used_bytes >= 0),
  disk_cap_bytes bigint CHECK (disk_cap_bytes IS NULL OR disk_cap_bytes > 0),
  disk_checked_at timestamptz,
  CHECK (NOT ai_paused OR ai_reason IS NOT NULL)
);
INSERT INTO ops_controls (id) VALUES (true);
CREATE TRIGGER ops_controls_no_delete BEFORE DELETE OR TRUNCATE ON ops_controls FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();

CREATE TABLE ops_control_log (
  id bigserial PRIMARY KEY,
  control text NOT NULL CHECK (control IN ('ai_pause', 'ai_resume', 'disk_pressure_on', 'disk_pressure_off')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor text NOT NULL CHECK (actor IN ('operator', 'supervisor')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
SELECT pw_make_immutable('ops_control_log');
