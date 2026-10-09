// The gate on the paper's own records (PW-043): what a paragraph is checked against, and the kept runs.
// - facts: verified facts from verified evidence, limited to the ids the caller says are settled
//   (PW-037 gates; the caller passes them, since search depends on this package);
// - references: the paper's references, with retraction known to the owner's library;
// - claims: the approved, settled claims of the outline plans the paragraph is linked to.
import { DomainError, UUID_RE, type Queryable } from '../shared/db.ts';
import { listReferences } from '../references/index.ts';
import { noticesOf } from '../literature/index.ts';
import { documentAt } from '../writer/index.ts';
import { scientificGate, type Finding, type GateFact, type GateReference } from './index.ts';

export async function gateFacts(db: Queryable, paperId: string, factIds: Iterable<string>): Promise<GateFact[]> {
  return (await db.query<GateFact>(
    `SELECT f.id, f.evidence_id, e.label AS evidence_label, e.locator, f.entity, f.metric, f.value_text, f.unit, f.group_label, f.comparison, f.n,
            COALESCE((SELECT json_agg(json_build_object('kind', s.kind, 'value_text', s.value_text) ORDER BY s.kind) FROM fact_statistics s WHERE s.fact_id = f.id), '[]') AS statistics
     FROM fact_records f JOIN evidence_records e ON e.id = f.evidence_id
     WHERE f.paper_id = $1 AND f.id = ANY($2::uuid[]) AND f.verification_state = 'VERIFIED' AND e.extraction_state = 'VERIFIED'
     ORDER BY f.created_at, f.id`, [paperId, [...factIds]])).rows;
}

export async function gateReferences(db: Queryable, paperId: string): Promise<GateReference[]> {
  const owner = (await db.query<{ owner_id: string }>('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0]!.owner_id;
  const out: GateReference[] = [];
  for (const r of await listReferences(db, paperId)) {
    const retracted = (await noticesOf(db, owner, r.id)).some((n) => n.kind === 'retracted');
    out.push({ id: r.id, label: `${r.authors[0]?.family ?? '?'}${r.authors.length > 1 ? ' et al.' : ''} ${r.year ?? 'n.d.'}`, retracted });
  }
  return out;
}

export interface CheckRun { id: string; document_id: string; revision_id: string; block_id: string; gate_version: string; status: string; findings: Finding[]; created_at: string }
const RUN = 'id, document_id, revision_id, block_id, gate_version, status, findings, created_at';

export async function checkManuscriptParagraph(db: Queryable, a: { paperId: string; ownerId: string; documentId: string; body: unknown; settled: { factIds: Set<string>; claimIds: Set<string> } }): Promise<CheckRun> {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['revision_id', 'block_id'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  if (!UUID_RE.test(a.documentId) || typeof b.revision_id !== 'string' || !UUID_RE.test(b.revision_id)) throw new DomainError('NOT_FOUND', 'document revision not found');
  const doc = await documentAt(db, a.paperId, a.documentId, b.revision_id.toLowerCase());
  if (!doc) throw new DomainError('NOT_FOUND', 'document revision not found');
  let block: ReturnType<typeof doc.child> | null = null;
  doc.forEach((n) => { if (typeof b.block_id === 'string' && n.attrs.id === b.block_id.toLowerCase()) block = n; });
  if (!block || (block as { type: { name: string } }).type.name !== 'paragraph') throw new DomainError('INVALID', 'block_id must name a paragraph of that revision', 'block_id');
  const blockId = (b.block_id as string).toLowerCase();
  // the approved, settled claims of the plans this paragraph belongs to (in the active outline)
  const claims = (await db.query<{ id: string; text: string }>(
    `SELECT DISTINCT c.id, c.text FROM outline_node_paragraphs l
     JOIN paper_projects p ON p.id = l.paper_id AND p.active_outline_revision_id = l.outline_revision_id
     JOIN outline_nodes n ON n.outline_revision_id = l.outline_revision_id AND n.node_id = l.node_id
     JOIN claims c ON c.paper_id = l.paper_id AND c.id::text = ANY(n.claim_ids) AND c.approval_state = 'APPROVED'
     WHERE l.paper_id = $1 AND l.document_id = $2 AND l.block_id = $3`, [a.paperId, a.documentId, blockId])).rows.filter((c) => a.settled.claimIds.has(c.id));
  const result = scientificGate({
    paragraph: (block as { toJSON(): { content?: [] } }).toJSON(),
    facts: await gateFacts(db, a.paperId, a.settled.factIds),
    references: await gateReferences(db, a.paperId),
    claims,
  });
  return (await db.query<CheckRun>(
    `INSERT INTO scientific_check_runs (paper_id, document_id, revision_id, block_id, gate_version, status, findings, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${RUN}`,
    [a.paperId, a.documentId, (b.revision_id as string).toLowerCase(), blockId, result.version, result.status, JSON.stringify(result.findings), a.ownerId])).rows[0]!;
}

export async function listScientificChecks(db: Queryable, paperId: string, documentId: string, blockId: unknown) {
  if (!UUID_RE.test(documentId) || typeof blockId !== 'string' || !UUID_RE.test(blockId)) throw new DomainError('INVALID', 'block_id is required', 'block_id');
  return (await db.query<CheckRun>(`SELECT ${RUN} FROM scientific_check_runs WHERE paper_id = $1 AND document_id = $2 AND block_id = $3 ORDER BY created_at DESC, id DESC LIMIT 20`, [paperId, documentId, blockId.toLowerCase()])).rows;
}
