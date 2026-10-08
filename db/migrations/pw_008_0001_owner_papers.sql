-- PW-008: owners, sessions, paper projects.
-- One deployment normally has a single owner; the schema allows more so that cross-owner
-- access (IDOR) can be regression-tested.
CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{3,64}$'),
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Session tokens are never stored: only sha256(token). The CSRF token is stored the same way.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  owner_id uuid NOT NULL REFERENCES owners(id),
  csrf_hash text NOT NULL CHECK (length(csrf_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_owner_idx ON sessions(owner_id);

CREATE TABLE paper_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  working_title text NOT NULL CHECK (length(btrim(working_title)) BETWEEN 1 AND 500),
  article_type text NOT NULL CHECK (article_type IN ('research_article', 'software_resource', 'methods', 'review', 'short_communication', 'other')),
  language text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  target_journal text CHECK (target_journal IS NULL OR length(target_journal) <= 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- user decision 2026-10-08: material the user puts into a paper may be sent to the selected
  -- provider; a per-paper switch can block it (e.g. identifiable human data)
  external_send_policy text NOT NULL DEFAULT 'allow_selected' CHECK (external_send_policy IN ('allow_selected', 'block')),
  data_classification text NOT NULL DEFAULT 'unpublished' CHECK (data_classification IN ('unpublished', 'public', 'sensitive')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  -- lets child tables reference (paper_id, owner_id) pairs if needed
  UNIQUE (id, owner_id)
);
CREATE INDEX paper_projects_owner_idx ON paper_projects(owner_id, status);
