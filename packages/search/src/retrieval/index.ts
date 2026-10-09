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
// - A fact or claim read from a cited source inherits that source's gate (still in the paper, not known
//   to be retracted, sendable). A sensitive paper sends nothing.
// - The context is computed fresh on every call; nothing is served from storage. A fingerprint of every
//   input (with the rules' version) records what was assembled; the latest few records per paragraph
//   and provider are kept.
import { createHash } from 'node:crypto';
import { DomainError, UUID_RE, type Queryable } from '@pw/domain/shared/db.ts';
import { canonicalJson } from '@pw/domain/revisions/index.ts';
import { externalSendDecision } from '@pw/domain/asset-policy/index.ts';
import { noticesOf } from '@pw/domain/literature/index.ts';
import { nodeScope } from '@pw/domain/outline-impact/index.ts';

// part of every fingerprint: a change of these rules is a change of the context
export const RETRIEVAL_VERSION = 'pw-retrieval-3'; // 3: unsupported observations withheld (PW-040 review)
const KEEP_RECORDS = 20;

export type Via = 'citation' | 'figure_ref' | 'claim' | 'lexical';
export interface ContextItem { kind: 'excerpt' | 'fact' | 'claim'; id: string; text: string; via: Via; locator: Record<string, unknown>; score?: number }
export interface Withheld { kind: string; id: string; via: Via; reason: string }
// recorded_before: an identical context (same fingerprint) was assembled and recorded earlier. The context
// returned is always the one computed now.
export interface RetrievedContext { paragraph: { block_id: string; text: string }; items: ContextItem[]; withheld: Withheld[]; truncated: boolean; fingerprint: string; recorded_before: boolean }

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

// The gate of each source a record comes from (a cited work): still in the paper, not known to be
// retracted, and — for text copied from it — sendable under its document's permission. Facts and
// claims read from a source inherit its gate.
async function sourceGates(db: Queryable, paperId: string, provider: string) {
  const ev = (await db.query<{ id: string; reference_id: string; locator: Record<string, unknown>; removed: boolean | null; content_hash: string; extraction_state: string }>(
    `SELECT e.id, e.reference_id, e.locator, e.content_hash, e.extraction_state, (r.reference_id IS NULL OR r.removed_at IS NOT NULL) AS removed
     FROM evidence_records e LEFT JOIN project_references r ON r.paper_id = e.paper_id AND r.reference_id = e.reference_id
     WHERE e.paper_id = $1 AND e.reference_id IS NOT NULL`, [paperId])).rows;
  // confirmed PDF locations, in one query
  const anchorIds = ev.map((e) => e.locator.anchor_id).filter((x): x is string => typeof x === 'string' && UUID_RE.test(x));
  const anchors = new Map((await db.query<{ id: string; asset_revision_id: string; page_index: number; sha256: string }>(
    'SELECT id, asset_revision_id, page_index, sha256 FROM pdf_anchors WHERE paper_id = $1 AND id = ANY($2::uuid[])', [paperId, anchorIds])).rows.map((a) => [a.id, a]));
  // send decisions per document (one per distinct asset)
  const decisions = new Map<string, { allowed: boolean; reasons: string[] }>();
  for (const assetId of new Set([...anchors.values()].map((a) => a.asset_revision_id))) decisions.set(assetId, await externalSendDecision(db, { paperId, assetId, provider }));
  // works the owner's library knows as retracted (own flag or a notice about them)
  const refIds = [...new Set(ev.map((e) => e.reference_id))];
  const retracted = new Set<string>();
  const owner = refIds.length ? (await db.query<{ owner_id: string }>('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0]!.owner_id : '';
  for (const refId of refIds) {
    if ((await noticesOf(db, owner, refId)).some((n) => n.kind === 'retracted')) retracted.add(refId);
  }
  const gates = new Map<string, { removed: boolean; reason: string | null; anchor: { id: string; page_index: number; sha256: string } | null; stateKey: unknown }>();
  for (const e of ev) {
    const anchorId = typeof e.locator.anchor_id === 'string' && UUID_RE.test(e.locator.anchor_id) ? e.locator.anchor_id : null;
    const anchor = anchorId ? anchors.get(anchorId) ?? null : null;
    const send = anchor ? decisions.get(anchor.asset_revision_id)! : { allowed: false, reasons: ['no_confirmed_source_document'] };
    const reason = retracted.has(e.reference_id) ? 'source_retracted' : send.allowed ? null : send.reasons.join(',');
    gates.set(e.id, { removed: !!e.removed, reason, anchor: anchor ? { id: anchor.id, page_index: anchor.page_index, sha256: anchor.sha256 } : null, stateKey: [e.id, e.content_hash, e.extraction_state, e.removed, anchorId, send, retracted.has(e.reference_id)] });
  }
  return gates;
}

async function candidatePool(db: Queryable, paperId: string, provider: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const gates = await sourceGates(db, paperId, provider);
  // verified literature excerpts of references still in the paper
  const excerpts = (await db.query<{ id: string; reference_id: string; locator: Record<string, unknown>; content_hash: string }>(
    `SELECT e.id, e.reference_id, e.locator, e.content_hash FROM evidence_records e
     WHERE e.paper_id = $1 AND e.kind = 'literature_excerpt' AND e.extraction_state = 'VERIFIED' ORDER BY e.created_at, e.id`, [paperId])).rows;
  for (const e of excerpts) {
    const g = gates.get(e.id)!;
    if (g.removed) continue;
    out.push({
      kind: 'excerpt', id: e.id, text: String(e.locator.quote ?? ''), evidenceId: e.id, referenceId: e.reference_id, figureId: null,
      locator: { reference_id: e.reference_id, anchor_id: g.anchor?.id ?? null, page_index: g.anchor?.page_index ?? null, sha256: g.anchor?.sha256 ?? null },
      withheld: g.reason, stateKey: g.stateKey,
    });
  }
  // open review flags, in two queries (facts flagged; evidence whose claims are flagged)
  const flaggedFacts = new Set((await db.query<{ id: string }>("SELECT fact_id AS id FROM figure_review_flags WHERE paper_id = $1 AND status = 'open' AND fact_id IS NOT NULL", [paperId])).rows.map((r) => r.id));
  const flaggedClaims = new Set((await db.query<{ id: string }>("SELECT claim_id AS id FROM figure_review_flags WHERE paper_id = $1 AND status = 'open' AND claim_id IS NOT NULL", [paperId])).rows.map((r) => r.id));
  const claimsOfEvidence = new Map<string, string[]>();
  for (const l of (await db.query<{ evidence_id: string; claim_id: string }>('SELECT evidence_id, claim_id FROM claim_evidence_links WHERE paper_id = $1', [paperId])).rows) {
    claimsOfEvidence.set(l.evidence_id, [...(claimsOfEvidence.get(l.evidence_id) ?? []), l.claim_id]);
  }
  // verified facts on verified evidence: from figures/tables only when read from the current version
  // without open review; from a cited source only under that source's gate
  const facts = (await db.query<{ id: string; evidence_id: string; entity: string; metric: string; value_text: string; unit: string; group_label: string; comparison: string; n: number | null; content_hash: string;
    figure_id: string | null; panel: string | null; version_no: number | null; current_no: number | null; archived: boolean | null }>(
    `SELECT fr.id, fr.evidence_id, fr.entity, fr.metric, fr.value_text, fr.unit, fr.group_label, fr.comparison, fr.n, fr.content_hash,
       l.figure_id, l.panel, v.version_no, (SELECT max(version_no) FROM figure_versions WHERE figure_id = l.figure_id) AS current_no, (o.archived_at IS NOT NULL) AS archived
     FROM fact_records fr JOIN evidence_records e ON e.id = fr.evidence_id
       LEFT JOIN figure_evidence_links l ON l.evidence_id = fr.evidence_id LEFT JOIN figure_versions v ON v.id = l.figure_version_id LEFT JOIN figure_objects o ON o.id = l.figure_id
     WHERE fr.paper_id = $1 AND fr.verification_state = 'VERIFIED' AND e.extraction_state = 'VERIFIED' ORDER BY fr.created_at, fr.id`, [paperId])).rows;
  for (const f of facts) {
    const g = gates.get(f.evidence_id);
    if (g?.removed) continue;
    const flagged = flaggedFacts.has(f.id) || (claimsOfEvidence.get(f.evidence_id) ?? []).some((c) => flaggedClaims.has(c));
    const withheld = g?.reason ?? (f.figure_id && f.archived ? 'figure_archived' : f.figure_id && f.version_no !== f.current_no ? 'read_from_older_figure_version' : flagged ? 'open_review_flags' : null);
    out.push({
      kind: 'fact', id: f.id, evidenceId: f.evidence_id, referenceId: null, figureId: f.figure_id,
      text: `${f.entity} · ${f.metric} = ${f.value_text}${f.unit ? ` ${f.unit}` : ''}${f.group_label ? `; group: ${f.group_label}` : ''}${f.comparison ? `; compared with: ${f.comparison}` : ''}${f.n ? `; n=${f.n}` : ''}`,
      locator: { evidence_id: f.evidence_id, figure_id: f.figure_id, panel: f.panel, version_no: f.version_no },
      withheld, stateKey: [f.id, f.content_hash, f.version_no, f.current_no, f.archived, flagged, g?.stateKey ?? null],
    });
  }
  // approved claims: withheld when flagged, or when any evidence they rely on comes from a source that may not go out
  const claims = (await db.query<{ id: string; kind: string; text: string; content_hash: string; evidence: string[]; supported: boolean }>(
    `SELECT c.id, c.kind, c.text, c.content_hash, coalesce(array_agg(l.evidence_id ORDER BY l.evidence_id) FILTER (WHERE l.evidence_id IS NOT NULL), '{}') AS evidence,
            bool_or(l.relation = 'supports' AND e.extraction_state = 'VERIFIED') AS supported
     FROM claims c LEFT JOIN claim_evidence_links l ON l.claim_id = c.id LEFT JOIN evidence_records e ON e.id = l.evidence_id
     WHERE c.paper_id = $1 AND c.approval_state = 'APPROVED' GROUP BY c.id ORDER BY c.id`, [paperId])).rows;
  for (const c of claims) {
    const sourceReason = c.evidence.map((e) => gates.get(e)).find((g) => g && (g.removed || g.reason));
    // an observation whose supporting evidence was withdrawn is no longer settled (PW-040 review MAJOR)
    const unsupported = c.kind === 'observation' && c.supported !== true;
    const withheld = flaggedClaims.has(c.id) ? 'open_review_flags' : unsupported ? 'claim_unsupported' : sourceReason ? (sourceReason.removed ? 'source_removed' : sourceReason.reason) : null;
    out.push({ kind: 'claim', id: c.id, text: c.text, evidenceId: null, referenceId: null, figureId: null, locator: { evidence_ids: c.evidence }, withheld, stateKey: [c.id, c.content_hash, c.evidence, unsupported, flaggedClaims.has(c.id), c.evidence.map((e) => gates.get(e)?.stateKey ?? null)] });
  }
  return out;
}

// The paper's settled facts and approved claims that may serve as material for this provider (PW-039
// review): the same gates as a paragraph context — not from a removed or retracted source, not from a
// source that may not be sent, not read from an older figure version, no open review flag.
export interface SettledMaterial { factIds: Set<string>; claimIds: Set<string>; excerptIds: Set<string>; withheld: { kind: string; id: string; reason: string }[] }
export async function settledMaterial(db: Queryable, paperId: string, provider: string): Promise<SettledMaterial> {
  const pool = await candidatePool(db, paperId, provider);
  const ok = (k: string) => new Set(pool.filter((c) => c.kind === k && !c.withheld).map((c) => c.id));
  return { factIds: ok('fact'), claimIds: ok('claim'), excerptIds: ok('excerpt'), withheld: pool.filter((c) => c.withheld).map((c) => ({ kind: c.kind, id: c.id, reason: c.withheld! })) };
}

// The generation scope of an approved node as it may go to this provider: nodeScope with the gates of
// that same provider. The only way callers build a scope (PW-040 review NIT: a scope never gets the
// settled set of another provider, or none).
export async function nodeScopeFor(db: Queryable, a: { paperId: string; outlineRevisionId: string; nodeId: string; provider: string }) {
  return nodeScope(db, a.paperId, a.outlineRevisionId, a.nodeId, await settledMaterial(db, a.paperId, a.provider));
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
  // nothing of this paper goes to a provider the paper does not allow; nothing of a sensitive paper goes
  // out at all until a redaction policy exists (spec 09)
  if (paper.data_classification === 'sensitive') throw new DomainError('FORBIDDEN', 'this paper is marked sensitive: nothing is sent to an external provider', 'provider', { details: { reason: 'paper_is_sensitive' } });
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
    version: RETRIEVAL_VERSION, head: doc.head_revision_id, block: o.blockId, provider: o.provider, paper, maxItems, maxChars, lexical: o.lexical ?? 5, pool: pool.map((c) => c.stateKey),
  })).digest('hex');
  const ctx = { paragraph: { block_id: o.blockId, text: paragraphText }, items: kept, withheld, truncated: kept.length < items.length };
  // The context is always the one computed now. A record of it is kept (the latest few per paragraph and
  // provider), so it can be shown what was assembled; a stored context is never served in its place.
  const before = (await db.query('SELECT 1 FROM retrieval_cache WHERE paper_id = $1 AND document_id = $2 AND block_id = $3 AND provider = $4 AND fingerprint = $5', [o.paperId, o.documentId, o.blockId, o.provider, fingerprint])).rowCount;
  if (!before) {
    await db.query('INSERT INTO retrieval_cache (paper_id, document_id, block_id, provider, fingerprint, context) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
      [o.paperId, o.documentId, o.blockId, o.provider, fingerprint, JSON.stringify(ctx)]);
    await db.query(`DELETE FROM retrieval_cache WHERE id IN (SELECT id FROM retrieval_cache WHERE paper_id = $1 AND document_id = $2 AND block_id = $3 AND provider = $4
      ORDER BY created_at DESC, id DESC OFFSET $5)`, [o.paperId, o.documentId, o.blockId, o.provider, KEEP_RECORDS]);
  }
  return { ...ctx, fingerprint, recorded_before: !!before };
}
