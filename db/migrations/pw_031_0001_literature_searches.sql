-- PW-031: bibliographic searches and their candidates (spec 05 "검색과 원문").
-- Every search is logged: the paper, the source, the exact query and parameters, the endpoint, the
-- API version the source reported, when it was observed, a hash of the response, and either the
-- candidates it returned or why the source was unavailable. Candidates keep the source's metadata,
-- record id, DOI (when given), preprint/published relations and update notices (retraction,
-- correction). Rows are never changed: a later search is a new row.
CREATE TABLE literature_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  created_by uuid NOT NULL REFERENCES owners(id),
  source text NOT NULL CHECK (source IN ('crossref', 'pubmed')),
  query text NOT NULL CHECK (char_length(btrim(query)) BETWEEN 1 AND 1000),
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  cache_key text NOT NULL CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  endpoint text NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 500),
  api_version text CHECK (api_version IS NULL OR char_length(api_version) <= 50),
  status text NOT NULL CHECK (status IN ('ok', 'source_unavailable')),
  unavailable_reason text CHECK (unavailable_reason IN ('auth', 'rate_limited', 'endpoint_changed', 'server_error', 'schema_changed', 'timeout', 'too_large', 'network')),
  http_status integer,
  retry_after_s integer CHECK (retry_after_s >= 0),
  response_sha256 text CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'),
  total_results integer CHECK (total_results >= 0),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'ok') = (unavailable_reason IS NULL))
);
CREATE INDEX literature_searches_cache ON literature_searches (paper_id, cache_key, observed_at DESC) WHERE status = 'ok';
SELECT pw_make_immutable('literature_searches');

CREATE TABLE literature_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id uuid NOT NULL REFERENCES literature_searches(id),
  paper_id uuid NOT NULL REFERENCES paper_projects(id),
  source text NOT NULL CHECK (source IN ('crossref', 'pubmed')),
  rank integer NOT NULL CHECK (rank >= 1),
  source_record_id text NOT NULL CHECK (char_length(source_record_id) BETWEEN 1 AND 300),
  doi text CHECK (doi IS NULL OR doi ~ '^10\.[0-9]{4,9}/\S+$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 2000),
  authors jsonb NOT NULL CHECK (jsonb_typeof(authors) = 'array'),
  year integer CHECK (year BETWEEN 1000 AND 3000),
  container text CHECK (container IS NULL OR char_length(container) <= 1000),
  work_type text CHECK (work_type IS NULL OR char_length(work_type) <= 100),
  is_preprint boolean NOT NULL DEFAULT false,
  relations jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(relations) = 'object'),
  update_notice jsonb CHECK (update_notice IS NULL OR jsonb_typeof(update_notice) = 'object'),
  UNIQUE (search_id, rank)
);
CREATE INDEX literature_candidates_doi ON literature_candidates (paper_id, doi);
SELECT pw_make_immutable('literature_candidates');
