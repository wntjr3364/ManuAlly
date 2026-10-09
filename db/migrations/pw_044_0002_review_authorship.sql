-- PW-044 review MINOR: a paragraph changed by an AI whose generator cannot be determined is not
-- "human_written" — it is unknown authorship (a same-model review cannot be ruled out).
ALTER TABLE review_runs DROP CONSTRAINT review_runs_independence_check;
ALTER TABLE review_runs ADD CONSTRAINT review_runs_independence_check CHECK (independence IN ('human_written', 'same_model', 'different_model', 'unknown_authorship'));
