-- PW-007 baseline. Later tasks add their own numbered files; applied files are never edited.
CREATE TABLE app_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO app_meta (key, value) VALUES ('db_schema', 'p01');
