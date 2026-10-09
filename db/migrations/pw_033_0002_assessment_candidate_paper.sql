-- PW-033 review: an assessment names a candidate of its own paper (structural, not only a worker check).
ALTER TABLE literature_candidates ADD CONSTRAINT literature_candidates_paper_id_id_key UNIQUE (paper_id, id);
ALTER TABLE curation_assessments ADD CONSTRAINT curation_assessments_candidate_paper_fk FOREIGN KEY (paper_id, candidate_id) REFERENCES literature_candidates(paper_id, id);
