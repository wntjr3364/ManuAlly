-- PW-018: comment threads on manuscript text (spec 04 "Comment / Highlight").
-- Rules enforced here (not only in the API):
--   * anchors and messages are append-only; the newest anchor of a thread is its current one
--   * a thread's only changing field is its state: OPEN <-> RESOLVED, stamped with the database clock
--   * every row carries paper_id in composite keys (no cross-paper links)

CREATE TABLE comment_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  document_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RESOLVED')),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state_changed_by uuid REFERENCES owners(id),
  state_changed_at timestamptz,
  UNIQUE (paper_id, id),
  FOREIGN KEY (paper_id, document_id) REFERENCES documents(paper_id, id)
);
CREATE INDEX comment_threads_doc ON comment_threads (document_id, created_at);

CREATE FUNCTION pw_comment_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable: comment threads cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'OPEN' OR NEW.state_changed_by IS NOT NULL OR NEW.state_changed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a comment thread is created OPEN' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'state_changed_by', 'state_changed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'state_changed_by', 'state_changed_at']) THEN
    RAISE EXCEPTION 'immutable: only the state of a comment thread changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state_changed_by IS NULL THEN
      RAISE EXCEPTION 'a state change needs the owner who made it' USING ERRCODE = 'check_violation';
    END IF;
    NEW.state_changed_at := clock_timestamp();
  ELSIF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'nothing else of a comment thread changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER comment_threads_guard BEFORE INSERT OR UPDATE OR DELETE ON comment_threads FOR EACH ROW EXECUTE FUNCTION pw_comment_thread_guard();
CREATE TRIGGER comment_threads_no_truncate BEFORE TRUNCATE ON comment_threads FOR EACH STATEMENT EXECUTE FUNCTION pw_forbid_change();
CREATE TRIGGER comment_threads_audit AFTER INSERT OR UPDATE ON comment_threads FOR EACH ROW EXECUTE FUNCTION pw_audit_state('comment_thread', 'state');

CREATE TABLE comment_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  document_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  block_id uuid NOT NULL,
  from_pos integer NOT NULL CHECK (from_pos >= 0),
  to_pos integer NOT NULL,
  quote text NOT NULL CHECK (length(quote) BETWEEN 1 AND 20000),
  prefix text NOT NULL CHECK (length(prefix) <= 64),
  suffix text NOT NULL CHECK (length(suffix) <= 64),
  created_by uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (to_pos > from_pos),
  FOREIGN KEY (paper_id, thread_id) REFERENCES comment_threads(paper_id, id),
  FOREIGN KEY (paper_id, document_id, revision_id) REFERENCES document_revisions(paper_id, document_id, id)
);
CREATE INDEX comment_anchors_thread ON comment_anchors (thread_id, created_at DESC, id);
SELECT pw_make_immutable('comment_anchors');

CREATE TABLE comment_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  author_id uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (paper_id, thread_id) REFERENCES comment_threads(paper_id, id)
);
CREATE INDEX comment_messages_thread ON comment_messages (thread_id, created_at, id);
SELECT pw_make_immutable('comment_messages');

-- an anchor and its thread belong to the same document
CREATE FUNCTION pw_comment_anchor_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM comment_threads t WHERE t.id = NEW.thread_id AND t.document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'an anchor must point into its thread''s document' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER comment_anchors_document BEFORE INSERT ON comment_anchors FOR EACH ROW EXECUTE FUNCTION pw_comment_anchor_document();
