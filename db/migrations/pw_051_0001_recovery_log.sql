-- PW-051: a record of each recovery sweep (spec 08 "신뢰 가능한 queue"): runs whose lease expired and what
-- became of them (queued again, or failed after their attempts), messages sent again because the queue lost
-- them, reservations of ended runs settled. Rows are never changed.
CREATE TABLE recovery_log (
  id bigserial PRIMARY KEY,
  requeued integer NOT NULL CHECK (requeued >= 0),
  failed integer NOT NULL CHECK (failed >= 0),
  redispatched integer NOT NULL CHECK (redispatched >= 0),
  settled integer NOT NULL CHECK (settled >= 0),
  jobs jsonb NOT NULL CHECK (jsonb_typeof(jobs) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
SELECT pw_make_immutable('recovery_log');
