-- PW-058: reviewer comments, the owner's responses, and frozen submissions (spec 10 "Reviewer workflow",
-- "SubmissionSnapshot").
-- review_comments: a reviewer's comment as the owner pasted it, with the manuscript revision it was made on.
-- review_responses: the owner's answers, latest first; an answer that says the text was changed
--   ('addressed', 'partly_addressed') carries links to the changed blocks of later revisions (checked by the
--   server when written; the check result is stored with it). Earlier answers stay.
-- submissions: a frozen submission — the snapshot, its private source archive (PW-057), the DOCX hash, the
--   checks at freezing, the response trace and the versions. 'submission_ready' only with no blocker
--   (constraint) and the owner's confirmation. All three tables never change.
CREATE TABLE review_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  document_id uuid NOT NULL,
  base_revision_id uuid NOT NULL,
  round_label text NOT NULL CHECK (char_length(btrim(round_label)) BETWEEN 1 AND 40),
  reviewer_label text NOT NULL CHECK (char_length(btrim(reviewer_label)) BETWEEN 1 AND 80),
  position integer NOT NULL CHECK (position >= 1),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (paper_id, id),
  UNIQUE (paper_id, position),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id),
  FOREIGN KEY (paper_id, document_id, base_revision_id) REFERENCES document_revisions(paper_id, document_id, id)
);
SELECT pw_make_immutable('review_comments');

CREATE TABLE review_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('addressed', 'partly_addressed', 'disagree', 'explained', 'not_addressed')),
  body text NOT NULL CHECK (char_length(body) <= 20000),
  links jsonb NOT NULL CHECK (jsonb_typeof(links) = 'array'),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status IN ('addressed', 'partly_addressed')) = (jsonb_array_length(links) > 0)),
  FOREIGN KEY (paper_id, comment_id) REFERENCES review_comments(paper_id, id)
);
CREATE INDEX review_responses_comment ON review_responses (comment_id, created_at DESC);
SELECT pw_make_immutable('review_responses');

CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
  target text CHECK (target IS NULL OR char_length(target) <= 200),
  status text NOT NULL CHECK (status IN ('draft', 'submission_ready')),
  snapshot_id uuid NOT NULL,
  archive_export_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  docx_sha256 text NOT NULL CHECK (docx_sha256 ~ '^[0-9a-f]{64}$'),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks->'blocking') = 'array' AND jsonb_typeof(checks->'warnings') = 'array'),
  responses jsonb NOT NULL CHECK (jsonb_typeof(responses) = 'array'),
  versions jsonb NOT NULL CHECK (jsonb_typeof(versions) = 'object'),
  confirmed_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT submissions_ready_clean CHECK (status <> 'submission_ready' OR jsonb_array_length(checks->'blocking') = 0),
  FOREIGN KEY (paper_id, snapshot_id) REFERENCES paper_snapshots(paper_id, id),
  FOREIGN KEY (paper_id, archive_export_id) REFERENCES exports(paper_id, id),
  FOREIGN KEY (paper_id, document_id, revision_id) REFERENCES document_revisions(paper_id, document_id, id),
  UNIQUE (paper_id, id)
);
CREATE INDEX submissions_paper ON submissions (paper_id, created_at DESC);
SELECT pw_make_immutable('submissions');
