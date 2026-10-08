-- PW-008 review: spec 09 lists allowed_providers on PaperProject. Empty = no provider may receive
-- this paper's material (the default until the user enables one per paper).
ALTER TABLE paper_projects
  ADD COLUMN allowed_providers text[] NOT NULL DEFAULT '{}'
  CHECK (allowed_providers <@ ARRAY['claude_agent', 'codex']::text[]);
