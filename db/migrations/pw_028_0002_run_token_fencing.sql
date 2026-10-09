-- PW-028 review MAJOR: a run token belongs to one run of a job (its fencing token). The gateway honours
-- the token only while that job is RUNNING under that token: a cancelled or taken-over run's tool calls
-- create nothing. A token without a job (tests, tools outside a job) is unaffected.
ALTER TABLE agent_run_tokens ADD COLUMN job_fencing_token bigint CHECK (job_fencing_token >= 1);
ALTER TABLE agent_run_tokens ADD CONSTRAINT agent_run_tokens_job_fencing CHECK ((job_id IS NULL) = (job_fencing_token IS NULL));
ALTER TABLE agent_run_tokens ADD CONSTRAINT agent_run_tokens_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id);
