-- PW-028: the operating-system processes of provider runs (spec 07 "취소·소유권").
-- A worker records each run process it starts: the job and fencing token it ran under, the host,
-- the pid and process group, the process start time (to tell a reused pid apart) and a random run
-- marker the process carries in its environment. Stopping or reconciling a run ends a process group
-- only when the live process still matches this record — never by name, never broadly.
-- A row is written once and ended once (end time and reason); nothing else changes.
CREATE TABLE run_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 200),
  host text NOT NULL CHECK (char_length(host) BETWEEN 1 AND 255),
  pid integer NOT NULL CHECK (pid > 1),
  pgid integer NOT NULL CHECK (pgid > 1),
  proc_start_ticks bigint NOT NULL CHECK (proc_start_ticks >= 0),
  marker text NOT NULL UNIQUE CHECK (marker ~ '^[0-9a-f]{32}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('exited', 'interrupted', 'terminated', 'killed', 'reconciled', 'gone')),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX run_processes_open ON run_processes (host, started_at) WHERE ended_at IS NULL;
CREATE INDEX run_processes_job ON run_processes (job_id);

CREATE FUNCTION pw_028_end_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
     OR (to_jsonb(NEW) - 'ended_at' - 'end_reason') <> (to_jsonb(OLD) - 'ended_at' - 'end_reason') THEN
    RAISE EXCEPTION 'run_processes rows are immutable except ending them once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_processes_end_once BEFORE UPDATE OR DELETE ON run_processes FOR EACH ROW EXECUTE FUNCTION pw_028_end_once();
CREATE TRIGGER run_processes_no_truncate BEFORE TRUNCATE ON run_processes FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
