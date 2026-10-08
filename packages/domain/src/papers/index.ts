// Paper projects. Every query is scoped by owner id: a paper that belongs to someone else is
// indistinguishable from one that does not exist.
import { DomainError, UUID_RE, hasNul, type Queryable } from '../shared/db.ts';

export const ARTICLE_TYPES = ['research_article', 'software_resource', 'methods', 'review', 'short_communication', 'other'] as const;
export type ArticleType = (typeof ARTICLE_TYPES)[number];

export interface Paper {
  id: string;
  owner_id: string;
  working_title: string;
  article_type: ArticleType;
  language: string;
  target_journal: string | null;
  status: 'active' | 'archived';
  external_send_policy: 'allow_selected' | 'block';
  data_classification: 'unpublished' | 'public' | 'sensitive';
  allowed_providers: string[];
  active_story_revision_id: string | null;
  active_outline_revision_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

const COLUMNS = 'id, owner_id, working_title, article_type, language, target_journal, status, external_send_policy, data_classification, allowed_providers, active_story_revision_id, active_outline_revision_id, version, created_at, updated_at, archived_at';

export interface PaperInput {
  working_title?: unknown;
  article_type?: unknown;
  language?: unknown;
  target_journal?: unknown;
  external_send_policy?: unknown;
  data_classification?: unknown;
}

function validate(input: PaperInput, { partial }: { partial: boolean }): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(input)) if (typeof v === 'string' && hasNul(v)) throw new DomainError('INVALID', `${k} contains a NUL character`, k);
  const has = (k: keyof PaperInput) => input[k] !== undefined;
  if (!partial || has('working_title')) {
    if (typeof input.working_title !== 'string' || !input.working_title.trim() || input.working_title.length > 500) throw new DomainError('INVALID', 'working_title must be 1–500 characters', 'working_title');
    out.working_title = input.working_title.trim();
  }
  if (!partial || has('article_type')) {
    if (!ARTICLE_TYPES.includes(input.article_type as ArticleType)) throw new DomainError('INVALID', `article_type must be one of ${ARTICLE_TYPES.join(', ')}`, 'article_type');
    out.article_type = input.article_type as string;
  }
  if (has('language')) {
    if (typeof input.language !== 'string' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(input.language)) throw new DomainError('INVALID', 'language must look like "en" or "en-GB"', 'language');
    out.language = input.language;
  }
  if (has('target_journal')) {
    if (input.target_journal !== null && (typeof input.target_journal !== 'string' || input.target_journal.length > 300)) throw new DomainError('INVALID', 'target_journal must be a string up to 300 characters or null', 'target_journal');
    out.target_journal = (input.target_journal as string | null) ?? null;
  }
  if (has('external_send_policy')) {
    if (!['allow_selected', 'block'].includes(input.external_send_policy as string)) throw new DomainError('INVALID', 'external_send_policy must be allow_selected or block', 'external_send_policy');
    out.external_send_policy = input.external_send_policy as string;
  }
  if (has('data_classification')) {
    if (!['unpublished', 'public', 'sensitive'].includes(input.data_classification as string)) throw new DomainError('INVALID', 'data_classification must be unpublished, public or sensitive', 'data_classification');
    out.data_classification = input.data_classification as string;
  }
  return out;
}

export async function createPaper(db: Queryable, ownerId: string, input: PaperInput): Promise<Paper> {
  const v = validate(input, { partial: false });
  const cols = Object.keys(v);
  const { rows } = await db.query<Paper>(
    `INSERT INTO paper_projects (owner_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${COLUMNS}`,
    [ownerId, ...cols.map((c) => v[c])],
  );
  return rows[0]!;
}

export async function getPaper(db: Queryable, ownerId: string, paperId: string): Promise<Paper | null> {
  if (!UUID_RE.test(paperId)) return null;
  const { rows } = await db.query<Paper>(`SELECT ${COLUMNS} FROM paper_projects WHERE id = $1 AND owner_id = $2`, [paperId, ownerId]);
  return rows[0] ?? null;
}

export async function listPapers(db: Queryable, ownerId: string, { includeArchived = false } = {}): Promise<Paper[]> {
  const { rows } = await db.query<Paper>(
    `SELECT ${COLUMNS} FROM paper_projects WHERE owner_id = $1 ${includeArchived ? '' : "AND status = 'active'"} ORDER BY updated_at DESC, id`,
    [ownerId],
  );
  return rows;
}

// Optimistic concurrency: the caller states which version it edited.
export async function updatePaper(db: Queryable, ownerId: string, paperId: string, expectedVersion: unknown, input: PaperInput): Promise<Paper> {
  if (!Number.isInteger(expectedVersion)) throw new DomainError('INVALID', 'expected_version is required', 'expected_version');
  const v = validate(input, { partial: true });
  const cols = Object.keys(v);
  if (!cols.length) throw new DomainError('INVALID', 'nothing to update');
  const current = await getPaper(db, ownerId, paperId);
  if (!current) throw new DomainError('NOT_FOUND', 'paper not found');
  const { rows } = await db.query<Paper>(
    `UPDATE paper_projects SET ${cols.map((c, i) => `${c} = $${i + 4}`).join(', ')}, version = version + 1, updated_at = now()
     WHERE id = $1 AND owner_id = $2 AND version = $3 RETURNING ${COLUMNS}`,
    [paperId, ownerId, expectedVersion, ...cols.map((c) => v[c])],
  );
  if (!rows[0]) throw new DomainError('CONFLICT', `paper was changed (current version ${current.version}); reload and retry`);
  return rows[0];
}

export async function setArchived(db: Queryable, ownerId: string, paperId: string, archived: boolean): Promise<Paper> {
  const current = await getPaper(db, ownerId, paperId);
  if (!current) throw new DomainError('NOT_FOUND', 'paper not found');
  if ((current.status === 'archived') === archived) return current; // idempotent: nothing changes
  const { rows } = await db.query<Paper>(
    `UPDATE paper_projects SET status = $3, archived_at = ${archived ? 'now()' : 'NULL'}, version = version + 1, updated_at = now()
     WHERE id = $1 AND owner_id = $2 RETURNING ${COLUMNS}`,
    [paperId, ownerId, archived ? 'archived' : 'active'],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'paper not found');
  return rows[0];
}
