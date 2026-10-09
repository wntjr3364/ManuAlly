// Change impact on outline nodes (PW-040, spec 03 "변경 영향"). An impact is derived, never guessed:
// a node relies on claims and evidence (and, through the evidence, on facts, figure versions and cited
// works). When one of them changes — a claim or evidence withdrawn or gone, a fact retracted, the figure
// redrawn (a newer version than the one read), the cited work removed from the paper or known to be
// retracted — the node shows the impact, with the manuscript paragraphs linked to it, until the owner
// reviews it. Only that node's AI drafting waits (the draft gate); other nodes and every manual edit are
// untouched. A reviewed impact stays reviewed; a further change (another figure version) is a new one.
// The generation scope of an approved node is that node only: its goal and limits, its approved claims,
// verified evidence and the verified facts read from it, and its neighbours' goals and transitions.
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';
import { noticesOf } from '../literature/index.ts';

export type ImpactChange = 'claim_withdrawn' | 'claim_missing' | 'claim_unsupported' | 'figure_archived' | 'evidence_withdrawn' | 'evidence_missing' | 'fact_withdrawn' | 'source_removed' | 'source_retracted' | 'figure_version_changed';
export interface Impact {
  node_id: string; kind: 'claim' | 'evidence' | 'fact' | 'figure'; source_id: string; change: ImpactChange; key: string; detail: string;
  resolved: boolean; resolved_at: string | null; paragraphs: { document_id: string; block_id: string }[];
}
interface NodeRow { node_id: string; parent_node_id: string | null; position: number; section: string; role: string; paragraph_goal: string; claim_ids: string[]; evidence_ids: string[];
  allowed_interpretation: string; exclusions: string[]; transition: string; word_budget_min: number | null; word_budget_max: number | null }

const uuids = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()).filter((x) => UUID_RE.test(x)))];

async function revisionOf(db: Queryable, paperId: string, outlineRevisionId: string) {
  if (!UUID_RE.test(outlineRevisionId)) return null;
  return (await db.query<{ id: string; owner_id: string }>('SELECT o.id, p.owner_id FROM outline_revisions o JOIN paper_projects p ON p.id = o.paper_id WHERE o.id = $1 AND o.paper_id = $2', [outlineRevisionId, paperId])).rows[0] ?? null;
}

// the impacts as the sources stand now (without review state). A node depends on the claims and
// evidence it lists and, through each listed claim, on that claim's evidence (PW-040 review MAJOR);
// through evidence on the facts read from it, the figure version it was read from and the cited work.
async function derive(db: Queryable, paperId: string, rev: { id: string; owner_id: string }): Promise<Omit<Impact, 'resolved' | 'resolved_at' | 'paragraphs'>[]> {
  const nodes = (await db.query<{ node_id: string; claim_ids: string[]; evidence_ids: string[] }>('SELECT node_id, claim_ids, evidence_ids FROM outline_nodes WHERE outline_revision_id = $1 AND paper_id = $2 ORDER BY position', [rev.id, paperId])).rows;
  const claimIds = uuids(nodes.flatMap((n) => n.claim_ids));
  const claims = new Map((await db.query<{ id: string; kind: string; approval_state: string; text: string; supported: boolean | null }>(
    `SELECT c.id, c.kind, c.approval_state, c.text,
            bool_or(l.relation = 'supports' AND e.extraction_state = 'VERIFIED') AS supported
     FROM claims c LEFT JOIN claim_evidence_links l ON l.claim_id = c.id LEFT JOIN evidence_records e ON e.id = l.evidence_id
     WHERE c.paper_id = $1 AND c.id = ANY($2::uuid[]) GROUP BY c.id`, [paperId, claimIds])).rows.map((c) => [c.id, c]));
  const claimLinks = (await db.query<{ claim_id: string; evidence_id: string }>('SELECT claim_id, evidence_id FROM claim_evidence_links WHERE paper_id = $1 AND claim_id = ANY($2::uuid[]) ORDER BY claim_id, evidence_id', [paperId, claimIds])).rows;
  const evIds = uuids([...nodes.flatMap((n) => n.evidence_ids), ...claimLinks.map((l) => l.evidence_id)]);
  const evidence = new Map((await db.query<{ id: string; extraction_state: string; label: string; reference_id: string | null; ref_removed: boolean | null; removed_at: string | null }>(
    `SELECT e.id, e.extraction_state, e.label, e.reference_id, (r.reference_id IS NULL OR r.removed_at IS NOT NULL) AS ref_removed, r.removed_at
     FROM evidence_records e LEFT JOIN project_references r ON r.paper_id = e.paper_id AND r.reference_id = e.reference_id
     WHERE e.paper_id = $1 AND e.id = ANY($2::uuid[])`, [paperId, evIds])).rows.map((e) => [e.id, e]));
  const retractedFacts = (await db.query<{ id: string; evidence_id: string; entity: string; metric: string; value_text: string; unit: string }>(
    "SELECT id, evidence_id, entity, metric, value_text, unit FROM fact_records WHERE paper_id = $1 AND evidence_id = ANY($2::uuid[]) AND verification_state = 'RETRACTED'", [paperId, evIds])).rows;
  const figures = (await db.query<{ evidence_id: string; figure_id: string; read_version: string; read_no: number; current_version: string; current_no: number; title: string; archived_at: string | null }>(
    `SELECT l.evidence_id, l.figure_id, l.figure_version_id AS read_version, v.version_no AS read_no, cur.id AS current_version, cur.version_no AS current_no, o.title, o.archived_at
     FROM figure_evidence_links l JOIN figure_versions v ON v.id = l.figure_version_id JOIN figure_objects o ON o.id = l.figure_id
     JOIN LATERAL (SELECT id, version_no FROM figure_versions WHERE figure_id = l.figure_id ORDER BY version_no DESC LIMIT 1) cur ON true
     WHERE l.paper_id = $1 AND l.evidence_id = ANY($2::uuid[])`, [paperId, evIds])).rows;
  const retractedRefs = new Set<string>();
  for (const refId of new Set([...evidence.values()].map((e) => e.reference_id).filter((x): x is string => !!x))) {
    if ((await noticesOf(db, rev.owner_id, refId)).some((n) => n.kind === 'retracted')) retractedRefs.add(refId);
  }
  const epoch = (t: string | null) => (t ? String(new Date(t).getTime()) : '0');
  const out: Omit<Impact, 'resolved' | 'resolved_at' | 'paragraphs'>[] = [];
  for (const n of nodes) {
    const seen = new Set<string>();
    const add = (kind: Impact['kind'], source_id: string, change: ImpactChange, detail: string, key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ node_id: n.node_id, kind, source_id, change, key, detail });
    };
    const listedClaims = uuids(n.claim_ids);
    for (const id of listedClaims) {
      const c = claims.get(id);
      if (!c) add('claim', id, 'claim_missing', 'the claim no longer exists', `claim:${id}:claim_missing`);
      else if (c.approval_state === 'RETRACTED' || c.approval_state === 'REJECTED') add('claim', id, 'claim_withdrawn', c.text.slice(0, 300), `claim:${id}:claim_withdrawn`);
      // an approved observation left without verified supporting evidence
      else if (c.approval_state === 'APPROVED' && c.kind === 'observation' && c.supported !== true) add('claim', id, 'claim_unsupported', `${c.text.slice(0, 280)} — no verified supporting evidence is left`, `claim:${id}:claim_unsupported`);
    }
    // the evidence this node rests on: its own, then that of each listed claim (named in the key)
    const own = new Set(uuids(n.evidence_ids));
    const deps: { id: string; via: string | null }[] = [...own].map((id) => ({ id, via: null }));
    for (const l of claimLinks) if (listedClaims.includes(l.claim_id) && !own.has(l.evidence_id) && !deps.some((d) => d.id === l.evidence_id)) deps.push({ id: l.evidence_id, via: l.claim_id });
    for (const { id, via } of deps) {
      const pre = via ? `via-claim:${via}|` : '';
      const note = via ? ` (through claim: ${(claims.get(via)?.text ?? via).slice(0, 80)})` : '';
      const e = evidence.get(id);
      if (!e) { add('evidence', id, 'evidence_missing', `the evidence record no longer exists${note}`, `${pre}evidence:${id}:evidence_missing`); continue; }
      if (e.extraction_state === 'RETRACTED' || e.extraction_state === 'REJECTED') add('evidence', id, 'evidence_withdrawn', `${e.label}${note}`, `${pre}evidence:${id}:evidence_withdrawn`);
      // keyed by the removal time: a reference removed, added back and removed again is a new impact
      if (e.reference_id && e.ref_removed) add('evidence', id, 'source_removed', `${e.label}: the cited work was removed from the paper${note}`, `${pre}evidence:${id}:source_removed:${epoch(e.removed_at)}`);
      if (e.reference_id && retractedRefs.has(e.reference_id)) add('evidence', id, 'source_retracted', `${e.label}: the cited work is retracted${note}`, `${pre}evidence:${id}:source_retracted`);
      for (const f of retractedFacts.filter((f) => f.evidence_id === id)) add('fact', f.id, 'fact_withdrawn', `${f.entity} · ${f.metric} = ${f.value_text} ${f.unit}`.trim() + note, `${pre}fact:${f.id}:fact_withdrawn`);
      for (const g of figures.filter((g) => g.evidence_id === id)) {
        if (g.archived_at) add('figure', g.figure_id, 'figure_archived', `${g.title}: the figure was archived${note}`, `figure:${g.figure_id}:archived:${epoch(g.archived_at)}`);
        // keyed by the current version: each newer version is a new impact
        else if (g.read_version !== g.current_version) add('figure', g.figure_id, 'figure_version_changed', `${g.title}: read from version ${g.read_no}, now version ${g.current_no}${note}`, `figure:${g.figure_id}:version:${g.current_version}`);
      }
    }
  }
  return out;
}

export async function listImpacts(db: Queryable, paperId: string, outlineRevisionId: string): Promise<Impact[]> {
  const rev = await revisionOf(db, paperId, outlineRevisionId);
  if (!rev) throw new DomainError('NOT_FOUND', 'outline revision not found');
  return withState(db, paperId, rev.id, await derive(db, paperId, rev));
}
async function withState(db: Queryable, paperId: string, revId: string, list: Omit<Impact, 'resolved' | 'resolved_at' | 'paragraphs'>[]): Promise<Impact[]> {
  const res = new Map((await db.query<{ node_id: string; impact_key: string; resolved_at: string }>('SELECT node_id, impact_key, resolved_at FROM outline_impact_resolutions WHERE outline_revision_id = $1 AND paper_id = $2', [revId, paperId])).rows
    .map((r) => [`${r.node_id}|${r.impact_key}`, r.resolved_at]));
  const paras = (await db.query<{ node_id: string; document_id: string; block_id: string }>('SELECT node_id, document_id, block_id FROM outline_node_paragraphs WHERE outline_revision_id = $1 AND paper_id = $2 ORDER BY created_at, block_id', [revId, paperId])).rows;
  return list.map((i) => {
    const at = res.get(`${i.node_id}|${i.key}`) ?? null;
    return { ...i, resolved: at !== null, resolved_at: at, paragraphs: paras.filter((p) => p.node_id === i.node_id).map(({ document_id, block_id }) => ({ document_id, block_id })) };
  });
}

// nodes of this revision with an impact the owner has not reviewed (the draft gate and node status)
export async function unresolvedNodes(db: Queryable, paperId: string, outlineRevisionId: string): Promise<Set<string>> {
  const rev = await revisionOf(db, paperId, outlineRevisionId);
  if (!rev) return new Set();
  return new Set((await withState(db, paperId, rev.id, await derive(db, paperId, rev))).filter((i) => !i.resolved).map((i) => i.node_id));
}

export async function resolveImpact(pool: TxPool, a: { paperId: string; ownerId: string; outlineRevisionId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['intent', 'node_id', 'key', 'note'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  if (b.intent !== 'resolve_impact') throw new DomainError('INVALID', 'reviewing an impact needs the explicit intent "resolve_impact"', 'intent');
  if (typeof b.node_id !== 'string' || !UUID_RE.test(b.node_id) || typeof b.key !== 'string') throw new DomainError('INVALID', 'node_id and key name the impact', 'key');
  const note = b.note === undefined ? '' : String(b.note);
  if (note.length > 1000) throw new DomainError('INVALID', 'note is too long', 'note');
  return inTransaction(pool, async (tx) => {
    const rev = await revisionOf(tx, a.paperId, a.outlineRevisionId);
    if (!rev) throw new DomainError('NOT_FOUND', 'outline revision not found');
    await tx.query('SELECT 1 FROM outline_revisions WHERE id = $1 FOR SHARE', [rev.id]);
    const nodeId = (b.node_id as string).toLowerCase();
    const open = (await withState(tx, a.paperId, rev.id, await derive(tx, a.paperId, rev))).find((i) => i.node_id === nodeId && i.key === b.key);
    if (!open) throw new DomainError('INVALID', 'there is no such impact on this node now', 'key');
    if (open.resolved) return open;
    // a concurrent review of the same impact is the same review (review nit)
    await tx.query('INSERT INTO outline_impact_resolutions (paper_id, outline_revision_id, node_id, impact_key, resolution, note, resolved_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
      [a.paperId, rev.id, nodeId, b.key, 'reviewed', note, a.ownerId]);
    return { ...open, resolved: true };
  });
}

// The material the paragraph context gates allow for the run's provider (PW-037 settledMaterial; passed
// in by the caller, since search depends on this package): claims, facts and source excerpts that are
// not withheld, and why the others are.
export interface Settled { factIds: Set<string>; claimIds: Set<string>; excerptIds: Set<string>; withheld: { kind: string; id: string; reason: string }[] }

// the generation scope of one approved node (only what passes the gates; the rest listed as excluded)
export async function nodeScope(db: Queryable, paperId: string, outlineRevisionId: string, nodeId: string, settled: Settled) {
  const why = (kind: string, id: string) => settled.withheld.find((w) => w.kind === kind && w.id === id)?.reason ?? 'not_settled';
  const rev = await revisionOf(db, paperId, outlineRevisionId);
  if (!rev || !UUID_RE.test(nodeId)) throw new DomainError('NOT_FOUND', 'outline node not found');
  const nodes = (await db.query<NodeRow & { approved: boolean }>(
    `SELECT n.node_id, n.parent_node_id, n.position, n.section, n.role, n.paragraph_goal, n.claim_ids, n.evidence_ids, n.allowed_interpretation, n.exclusions, n.transition,
            n.word_budget_min, n.word_budget_max, (a.node_id IS NOT NULL) AS approved
     FROM outline_nodes n LEFT JOIN outline_node_approvals a ON a.outline_revision_id = n.outline_revision_id AND a.node_id = n.node_id
     WHERE n.outline_revision_id = $1 AND n.paper_id = $2 ORDER BY n.position`, [rev.id, paperId])).rows;
  const node = nodes.find((n) => n.node_id === nodeId.toLowerCase());
  if (!node) throw new DomainError('NOT_FOUND', 'outline node not found');
  if (!node.approved) throw new DomainError('CONFLICT', 'only an approved paragraph plan has a generation scope');
  const excluded: { kind: string; id: string; reason: string }[] = [];
  const claimRows = new Map((await db.query<{ id: string; kind: string; text: string; approval_state: string }>('SELECT id, kind, text, approval_state FROM claims WHERE paper_id = $1 AND id = ANY($2::uuid[])', [paperId, uuids(node.claim_ids)])).rows.map((c) => [c.id, c]));
  const claims: { id: string; kind: string; text: string }[] = [];
  for (const id of uuids(node.claim_ids)) {
    const c = claimRows.get(id);
    if (!c) excluded.push({ kind: 'claim', id, reason: 'missing' });
    else if (c.approval_state === 'APPROVED' && settled.claimIds.has(c.id)) claims.push({ id: c.id, kind: c.kind, text: c.text });
    else if (c.approval_state === 'APPROVED') excluded.push({ kind: 'claim', id, reason: why('claim', id) });
    else excluded.push({ kind: 'claim', id, reason: c.approval_state === 'DRAFT' ? 'not_approved' : 'withdrawn' });
  }
  const evRows = new Map((await db.query<{ id: string; kind: string; label: string; locator: unknown; extraction_state: string }>('SELECT id, kind, label, locator, extraction_state FROM evidence_records WHERE paper_id = $1 AND id = ANY($2::uuid[])', [paperId, uuids(node.evidence_ids)])).rows.map((e) => [e.id, e]));
  const evidence: { id: string; kind: string; label: string; locator: unknown }[] = [];
  for (const id of uuids(node.evidence_ids)) {
    const e = evRows.get(id);
    if (!e) excluded.push({ kind: 'evidence', id, reason: 'missing' });
    // a source excerpt carries the source's words: only where its gate allows (PW-037)
    else if (e.extraction_state === 'VERIFIED' && e.kind === 'literature_excerpt' && !settled.excerptIds.has(e.id)) excluded.push({ kind: 'evidence', id, reason: why('excerpt', id) });
    else if (e.extraction_state === 'VERIFIED') evidence.push({ id: e.id, kind: e.kind, label: e.label, locator: e.locator });
    else excluded.push({ kind: 'evidence', id, reason: e.extraction_state === 'CANDIDATE' ? 'not_verified' : 'withdrawn' });
  }
  const allFacts = (await db.query<{ id: string; evidence_id: string; entity: string; metric: string; value_text: string; unit: string; group_label: string; comparison: string; n: number | null }>(
    "SELECT id, evidence_id, entity, metric, value_text, unit, group_label, comparison, n FROM fact_records WHERE paper_id = $1 AND evidence_id = ANY($2::uuid[]) AND verification_state = 'VERIFIED' ORDER BY created_at, id",
    [paperId, evidence.map((e) => e.id)])).rows;
  // facts read from an older figure version, under open review, or from a source that may not go out stay out
  const facts = allFacts.filter((f) => settled.factIds.has(f.id));
  for (const f of allFacts) if (!settled.factIds.has(f.id)) excluded.push({ kind: 'fact', id: f.id, reason: why('fact', f.id) });
  const siblings = nodes.filter((n) => n.parent_node_id === node.parent_node_id);
  const i = siblings.findIndex((n) => n.node_id === node.node_id);
  const brief = (n: NodeRow | undefined) => (n ? { node_id: n.node_id, section: n.section, role: n.role, paragraph_goal: n.paragraph_goal, transition: n.transition } : null);
  const paragraphs = (await db.query<{ document_id: string; block_id: string }>('SELECT document_id, block_id FROM outline_node_paragraphs WHERE outline_revision_id = $1 AND node_id = $2 ORDER BY created_at', [rev.id, node.node_id])).rows;
  const plain: Partial<typeof node> = { ...node };
  delete plain.approved;
  return { outline_revision_id: rev.id, node: plain as NodeRow, claims, evidence, facts, excluded, neighbours: { previous: brief(siblings[i - 1]), next: brief(siblings[i + 1]) }, paragraphs };
}

export async function linkParagraph(pool: TxPool, a: { paperId: string; ownerId: string; outlineRevisionId: string; nodeId: string; body: unknown; origin?: 'user' | 'draft' }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['document_id', 'block_id'].includes(k)) || typeof b.document_id !== 'string' || typeof b.block_id !== 'string' || !UUID_RE.test(b.block_id)) {
    throw new DomainError('INVALID', 'document_id and block_id name the paragraph', 'block_id');
  }
  if (!UUID_RE.test(a.outlineRevisionId) || !UUID_RE.test(a.nodeId)) throw new DomainError('NOT_FOUND', 'outline node not found');
  const node = (await pool.query('SELECT 1 FROM outline_nodes WHERE outline_revision_id = $1 AND node_id = $2 AND paper_id = $3', [a.outlineRevisionId, a.nodeId.toLowerCase(), a.paperId])).rows[0];
  if (!node) throw new DomainError('NOT_FOUND', 'outline node not found');
  const doc = UUID_RE.test(b.document_id) ? (await pool.query('SELECT 1 FROM documents WHERE id = $1 AND paper_id = $2', [b.document_id, a.paperId])).rows[0] : undefined;
  if (!doc) throw new DomainError('NOT_FOUND', 'document not found');
  await pool.query(`INSERT INTO outline_node_paragraphs (paper_id, outline_revision_id, node_id, document_id, block_id, origin, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [a.paperId, a.outlineRevisionId, a.nodeId.toLowerCase(), (b.document_id as string).toLowerCase(), (b.block_id as string).toLowerCase(), a.origin ?? 'user', a.ownerId]);
  return { outline_revision_id: a.outlineRevisionId, node_id: a.nodeId.toLowerCase(), document_id: (b.document_id as string).toLowerCase(), block_id: (b.block_id as string).toLowerCase() };
}

export async function unlinkParagraph(pool: TxPool, a: { paperId: string; outlineRevisionId: string; nodeId: string; documentId: string; blockId: string }) {
  if (![a.outlineRevisionId, a.nodeId, a.documentId, a.blockId].every((x) => UUID_RE.test(x))) throw new DomainError('NOT_FOUND', 'link not found');
  const r = await pool.query('DELETE FROM outline_node_paragraphs WHERE paper_id = $1 AND outline_revision_id = $2 AND node_id = $3 AND document_id = $4 AND block_id = $5',
    [a.paperId, a.outlineRevisionId, a.nodeId.toLowerCase(), a.documentId.toLowerCase(), a.blockId.toLowerCase()]);
  if (!r.rowCount) throw new DomainError('NOT_FOUND', 'link not found');
}
