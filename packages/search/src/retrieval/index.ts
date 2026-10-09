// Only the evidence a selected paragraph needs (PW-037, spec 05, 08 "context").
// - Explicit selection first: the references the paragraph cites (their verified literature excerpts and
//   confirmed PDF locations) and the figures/tables it mentions (verified evidence read from the current
//   version and its verified facts), plus approved claims relying on that evidence.
// - Then project-scoped lexical retrieval: verified excerpts, facts and approved claims of the same
//   paper that share enough distinctive words with the paragraph (marked "lexical").
// - Everything comes from this paper only. Removed references and unverified, rejected or retracted
//   records never enter. What may not go to the provider is withheld with a reason, never included:
//   excerpt text needs the source document's external-send permission (all conditions, PW-034), and
//   evidence read from an older figure/table version or with open review flags is withheld.
// - A cached context is reused only for an identical fingerprint of every input (document revision,
//   paragraph, records and their states, permissions, policies, provider, limits): a changed approval,
//   a removed source or a withdrawn permission can never come back from the cache.
import { createHash } from 'node:crypto';
import { DomainError, UUID_RE, type Queryable } from '@pw/domain/shared/db.ts';
import { canonicalJson } from '@pw/domain/revisions/index.ts';
import { externalSendDecision } from '@pw/domain/asset-policy/index.ts';

export type Via = 'citation' | 'figure_ref' | 'claim' | 'lexical';
export interface ContextItem { kind: 'excerpt' | 'fact' | 'claim'; id: string; text: string; via: Via; locator: Record<string, unknown>; score?: number }
export interface Withheld { kind: string; id: string; via: Via; reason: string }
export interface RetrievedContext { paragraph: { block_id: string; text: string }; items: ContextItem[]; withheld: Withheld[]; truncated: boolean; fingerprint: string; cached: boolean }

interface DocNode { type?: string; text?: string; attrs?: Record<string, unknown>; content?: DocNode[] }
function findBlock(doc: DocNode, id: string): DocNode | null {
  if (doc.attrs?.id === id && ['paragraph', 'heading', 'table'].includes(String(doc.type))) return doc;
  for (const c of doc.content ?? []) { const f = findBlock(c, id); if (f) return f; }
  return null;
}
function collect(n: DocNode, out: { refs: Set<string>; figs: Set<string> }) {
  if (n.type === 'citation' && typeof n.attrs?.referenceId === 'string') out.refs.add(n.attrs.referenceId.toLowerCase());
  if (n.type === 'figure_ref' && typeof n.attrs?.targetId === 'string') out.figs.add(n.attrs.targetId.toLowerCase());
  for (const c of n.content ?? []) collect(c, out);
}
const textOf = (n: DocNode): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));

// ---- lexical ------------------------------------------------------------------------------------
const STOP = new Set('the and for with was were are that this from into than then have has had not but its our their these those which when where while also been being under over between within without after before about such each other more most less into onto per via using used use can may might shall should would could will does did done all any both only very same than'.split(' '));
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*/gu)) {
    const t = m[0];
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

// ---- the paper's candidate pool -----------------------------------------------------------------
interface Candidate { kind: ContextItem['kind']; id: string; text: string; locator: Record<string, unknown>; withheld: string | null; evidenceId: string | null; referenceId: string | null; figureId: string | null; stateKey: unknown }

async function candidatePool(db: Queryable, paperId: string, provider: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  // verified literature excerpts of references still in the paper
  const excerpts = (await db.query<{ id: string; reference_id: string; locator: Record<string, unknown>; content_hash: string }>(
    `SELECT e.id, e.reference_id, e.locator, e.content_hash FROM evidence_records e JOIN project_references r ON r.paper_id = e.paper_id AND r.reference_id = e.reference_id
     WHERE e.paper_id = $1 AND e.kind = 'literature_excerpt' AND e.extraction_state = 'VERIFIED' AND r.removed_at IS NULL ORDER BY e.created_at, e.id`, [paperId])).rows;
  for (const e of excerpts) {
    const anchorId = typeof e.locator.anchor_id === 'string' && UUID_RE.test(e.locator.anchor_id) ? e.locator.anchor_id : null;
    const anchor = anchorId ? (await db.query<{ asset_revision_id: string; page_index: number; sha256: string }>('SELECT asset_revision_id, page_index, sha256 FROM pdf_anchors WHERE paper_id = $1 AND id = $2', [paperId, anchorId])).rows[0] : undefined;
    // a quote is a copy of a source: it goes out only under the source document's send permission
    const send = anchor ? await externalSendDecision(db, { paperId, assetId: anchor.asset_revision_id, provider }) : { allowed: false, reasons: ['no_confirmed_source_document'] };
    out.push({
      kind: 'excerpt', id: e.id, text: String(e.locator.quote ?? ''), evidenceId: e.id, referenceId: e.reference_id, figureId: null,
      locator: { reference_id: e.reference_id, anchor_id: anchorId, page_index: anchor?.page_index ?? null, sha256: anchor?.sha256 ?? null },
      withheld: send.allowed ? null : send.reasons.join(','), stateKey: [e.id, e.content_hash, anchorId, send],
    });
  }
  // verified facts: from figure/table evidence only when read from the current version without open review
  const facts = (await db.query<{ id: string; evidence_id: string; entity: string; metric: string; value_text: string; unit: string; group_label: string; comparison: string; n: number | null; content_hash: string;
    figure_id: string | null; panel: string | null; version_no: number | null; current_no: number | null; archived: boolean | null; open_flags: number }>(
    `SELECT fr.id, fr.evidence_id, fr.entity, fr.metric, fr.value_text, fr.unit, fr.group_label, fr.comparison, fr.n, fr.content_hash,
       l.figure_id, l.panel, v.version_no, (SELECT max(version_no) FROM figure_versions WHERE figure_id = l.figure_id) AS current_no, (o.archived_at IS NOT NULL) AS archived,
       (SELECT count(*)::int FROM figure_review_flags r WHERE r.status = 'open' AND (r.fact_id = fr.id OR r.claim_id IN (SELECT claim_id FROM claim_evidence_links WHERE evidence_id = fr.evidence_id))) AS open_flags
     FROM fact_records fr JOIN evidence_records e ON e.id = fr.evidence_id
       LEFT JOIN figure_evidence_links l ON l.evidence_id = fr.evidence_id LEFT JOIN figure_versions v ON v.id = l.figure_version_id LEFT JOIN figure_objects o ON o.id = l.figure_id
     WHERE fr.paper_id = $1 AND fr.verification_state = 'VERIFIED' AND e.extraction_state = 'VERIFIED' ORDER BY fr.created_at, fr.id`, [paperId])).rows;
  for (const f of facts) {
    const withheld = f.figure_id && f.archived ? 'figure_archived' : f.figure_id && f.version_no !== f.current_no ? 'read_from_older_figure_version' : f.open_flags > 0 ? 'open_review_flags' : null;
    out.push({
      kind: 'fact', id: f.id, evidenceId: f.evidence_id, referenceId: null, figureId: f.figure_id,
      text: `${f.entity} ${f.metric} = ${f.value_text} ${f.unit} (${f.group_label}${f.comparison ? ` vs ${f.comparison}` : ''}${f.n ? `, n=${f.n}` : ''})`,
      locator: { evidence_id: f.evidence_id, figure_id: f.figure_id, panel: f.panel, version_no: f.version_no },
      withheld, stateKey: [f.id, f.content_hash, f.version_no, f.current_no, f.archived, f.open_flags],
    });
  }
  // approved claims (with the evidence they rely on)
  const claims = (await db.query<{ id: string; text: string; content_hash: string; evidence: string[]; open_flags: number }>(
    `SELECT c.id, c.text, c.content_hash, coalesce(array_agg(l.evidence_id) FILTER (WHERE l.evidence_id IS NOT NULL), '{}') AS evidence,
       (SELECT count(*)::int FROM figure_review_flags r WHERE r.status = 'open' AND r.claim_id = c.id) AS open_flags
     FROM claims c LEFT JOIN claim_evidence_links l ON l.claim_id = c.id WHERE c.paper_id = $1 AND c.approval_state = 'APPROVED' GROUP BY c.id ORDER BY c.id`, [paperId])).rows;
  for (const c of claims) {
    out.push({ kind: 'claim', id: c.id, text: c.text, evidenceId: null, referenceId: null, figureId: null, locator: { evidence_ids: c.evidence }, withheld: c.open_flags > 0 ? 'open_review_flags' : null, stateKey: [c.id, c.content_hash, c.evidence, c.open_flags] });
  }
  return out;
}

// Lexical search within one paper (used for the "related" part of a context, and on its own).
export function rankLexical(query: string, pool: { id: string; text: string }[], opts: { minShared?: number; limit?: number } = {}) {
  const q = terms(query);
  const docs = pool.map((c) => ({ id: c.id, t: terms(c.text) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.t) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length || 1;
  return docs
    .map((d) => {
      const shared = [...q].filter((t) => d.t.has(t));
      return { id: d.id, shared: shared.length, score: Math.round(shared.reduce((s, t) => s + Math.log(1 + n / (df.get(t) ?? 1)), 0) * 1000) / 1000 };
    })
    .filter((r) => r.shared >= (opts.minShared ?? 2))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, opts.limit ?? 5);
}

export interface RetrieveOptions { paperId: string; documentId: string; blockId: string; provider: string; maxItems?: number; maxChars?: number; lexical?: number }

export async function retrieveContext(db: Queryable, o: RetrieveOptions): Promise<RetrievedContext> {
  if (!UUID_RE.test(o.documentId) || typeof o.blockId !== 'string' || !o.blockId || o.blockId.length > 100) throw new DomainError('NOT_FOUND', 'paragraph not found');
  const paper = (await db.query<{ external_send_policy: string; data_classification: string; allowed_providers: string[] }>('SELECT external_send_policy, data_classification, allowed_providers FROM paper_projects WHERE id = $1', [o.paperId])).rows[0];
  if (!paper) throw new DomainError('NOT_FOUND', 'paper not found');
  // nothing of this paper goes to a provider the paper does not allow
  if (paper.external_send_policy !== 'allow_selected' || !paper.allowed_providers.includes(o.provider)) {
    throw new DomainError('FORBIDDEN', 'this paper does not allow sending material to this provider', 'provider', { details: { reason: 'provider_not_allowed' } });
  }
  const doc = (await db.query<{ head_revision_id: string; content_json: DocNode }>(
    'SELECT d.head_revision_id, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1 AND d.id = $2', [o.paperId, o.documentId])).rows[0];
  if (!doc) throw new DomainError('NOT_FOUND', 'paragraph not found');
  const block = findBlock(doc.content_json, o.blockId);
  if (!block) throw new DomainError('NOT_FOUND', 'paragraph not found');
  const paragraphText = textOf(block);
  const links = { refs: new Set<string>(), figs: new Set<string>() };
  collect(block, links);

  const pool = await candidatePool(db, o.paperId, o.provider);
  const chosen = new Map<string, Via>();
  for (const c of pool) {
    if (c.kind === 'excerpt' && c.referenceId && links.refs.has(c.referenceId)) chosen.set(c.id, 'citation');
    if (c.kind === 'fact' && c.figureId && links.figs.has(c.figureId)) chosen.set(c.id, 'figure_ref');
  }
  const chosenEvidence = new Set(pool.filter((c) => chosen.has(c.id) && !c.withheld && c.evidenceId).map((c) => c.evidenceId!));
  for (const c of pool) if (c.kind === 'claim' && (c.locator.evidence_ids as string[]).some((e) => chosenEvidence.has(e))) chosen.set(c.id, 'claim');
  // related by words (same paper only), after the explicit links
  const rest = pool.filter((c) => !chosen.has(c.id));
  const scores = new Map<string, number>();
  for (const r of rankLexical(paragraphText, rest, { limit: o.lexical ?? 5 })) { chosen.set(r.id, 'lexical'); scores.set(r.id, r.score); }

  const items: ContextItem[] = [];
  const withheld: Withheld[] = [];
  const order: Via[] = ['citation', 'figure_ref', 'claim', 'lexical'];
  const picked = pool.filter((c) => chosen.has(c.id)).sort((a, b) => order.indexOf(chosen.get(a.id)!) - order.indexOf(chosen.get(b.id)!) || (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  for (const c of picked) {
    const via = chosen.get(c.id)!;
    if (c.withheld) withheld.push({ kind: c.kind, id: c.id, via, reason: c.withheld });
    else items.push({ kind: c.kind, id: c.id, text: c.text, via, locator: c.locator, ...(scores.has(c.id) ? { score: scores.get(c.id) } : {}) });
  }
  // limits: whole items only, in a fixed order
  const maxItems = o.maxItems ?? 30;
  const maxChars = o.maxChars ?? 8000;
  let chars = 0;
  const kept: ContextItem[] = [];
  for (const it of items) {
    if (kept.length >= maxItems || chars + it.text.length > maxChars) break;
    kept.push(it);
    chars += it.text.length;
  }
  const fingerprint = createHash('sha256').update(canonicalJson({
    head: doc.head_revision_id, block: o.blockId, provider: o.provider, paper, maxItems, maxChars, lexical: o.lexical ?? 5, pool: pool.map((c) => c.stateKey),
  })).digest('hex');
  const ctx = { paragraph: { block_id: o.blockId, text: paragraphText }, items: kept, withheld, truncated: kept.length < items.length };
  const hit = (await db.query<{ context: Omit<RetrievedContext, 'fingerprint' | 'cached'> }>(
    'SELECT context FROM retrieval_cache WHERE paper_id = $1 AND document_id = $2 AND block_id = $3 AND provider = $4 AND fingerprint = $5', [o.paperId, o.documentId, o.blockId, o.provider, fingerprint])).rows[0];
  if (hit) return { ...hit.context, fingerprint, cached: true };
  await db.query('INSERT INTO retrieval_cache (paper_id, document_id, block_id, provider, fingerprint, context) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
    [o.paperId, o.documentId, o.blockId, o.provider, fingerprint, JSON.stringify(ctx)]);
  return { ...ctx, fingerprint, cached: false };
}
