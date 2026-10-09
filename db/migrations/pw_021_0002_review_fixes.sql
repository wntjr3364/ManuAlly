-- PW-021 review: keep the uploaded file's bytes as received (spec 10 "원본 asset을 먼저 불변 저장").
-- source_sha256 is the hash of these bytes; source_text is their strict UTF-8 decoding.
ALTER TABLE import_sources ADD COLUMN source_bytes bytea;
