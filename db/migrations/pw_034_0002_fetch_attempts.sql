-- PW-034 review: the daily fetch cap counts attempts reserved before any request leaves the server
-- (one 'attempted' row per fetch, written under a per-owner lock), and a failure after a fetch is still
-- recorded ('store_failed').
ALTER TABLE asset_fetches DROP CONSTRAINT asset_fetches_outcome_check;
ALTER TABLE asset_fetches ADD CONSTRAINT asset_fetches_outcome_check CHECK (outcome IN ('attempted', 'stored', 'store_failed', 'bad_url', 'host_not_allowed', 'internal_address', 'daily_cap', 'redirect', 'not_pdf', 'http_error', 'too_large', 'timeout', 'network', 'rejected_file'));
