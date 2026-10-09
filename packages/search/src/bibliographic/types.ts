export interface Author { family: string; given?: string }
export interface Candidate {
  source: 'crossref' | 'pubmed';
  source_record_id: string;
  doi: string | null;
  title: string;
  authors: Author[];
  year: number | null;
  container: string | null;
  work_type: string | null;
  is_preprint: boolean;
  relations: Record<string, string[]>;
  update_notice: { type: string; target_doi?: string | null; notice_doi?: string | null; notice_type?: string } | null;
}
export interface Parsed { apiVersion: string | null; total: number | null; items: Candidate[] }
