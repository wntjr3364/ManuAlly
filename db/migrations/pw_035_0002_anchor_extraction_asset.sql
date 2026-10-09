-- PW-035 review: an anchor's asset revision is the one its extraction was made from (structural).
ALTER TABLE pdf_extractions ADD CONSTRAINT pdf_extractions_id_asset_key UNIQUE (id, asset_revision_id);
ALTER TABLE pdf_anchors ADD CONSTRAINT pdf_anchors_extraction_asset_fk FOREIGN KEY (extraction_id, asset_revision_id) REFERENCES pdf_extractions(id, asset_revision_id);
