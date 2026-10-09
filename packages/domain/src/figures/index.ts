// Figure/table versions, their source evidence and impact review (PW-036, spec 05 "Figure/Table 관리").
// - A figure/table object (PW-019) keeps its id; its number comes from its place. Each change of its
//   file, caption, panels, units or groups is a new immutable version; the original file is kept.
// - Evidence read from a figure/table is linked to the version (and panel) it was read from.
// - A new version is never applied silently: the paragraphs that mention the figure (figure_ref in the
//   manuscript's current revision), the claims relying on evidence from it, and the facts read from a
//   changed panel get open review flags. Only the owner closes a flag.
// - A claim can be traced to its evidence, the figure/table version and panel, the source location in
//   a PDF and the fact values with their units and groups.

import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../shared/db.ts';
import { INSPECTOR_VERSION } from '../asset-policy/index.ts';

// ---- figure files -------------------------------------------------------------------------------
export const FIGURE_MEDIA = ['image/png', 'image/jpeg', 'text/csv'] as const;
export const MAX_FIGURE_BYTES = 20 * 1024 * 1024;
export type FigureMedia = (typeof FIGURE_MEDIA)[number];

// By content, not by the declared type alone. SVG/HTML are not accepted (they can carry script).
export function inspectFigureFile(buf: Buffer, media: string): { ok: true } | { ok: false; reason: string } {
  if (!FIGURE_MEDIA.includes(media as FigureMedia)) return { ok: false, reason: 'unsupported_type' };
  if (!buf.length) return { ok: false, reason: 'empty' };
  if (buf.length > MAX_FIGURE_BYTES) return { ok: false, reason: 'too_large' };
  if (media === 'image/png' && !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ok: false, reason: 'not_png' };
  if (media === 'image/jpeg' && !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return { ok: false, reason: 'not_jpeg' };
  if (media === 'text/csv') {
    const text = buf.toString('utf8');
    if (Buffer.from(text, 'utf8').length !== buf.length || text.includes('\u0000') || text.includes('�')) return { ok: false, reason: 'not_utf8_text' };
  }
  return { ok: true };
}

export async function recordFigureFile(pool: TxPool, a: { paperId: string; ownerId: string; sha256: string; byteSize: number; media: FigureMedia; name: string }) {
  return inTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`asset:${a.paperId}:${a.sha256}`]);
    const existing = (await tx.query<{ id: string }>("SELECT a.id FROM asset_revisions a JOIN asset_sources s ON s.asset_revision_id = a.id WHERE a.paper_id = $1 AND a.sha256 = $2 AND s.kind = 'figure_file'", [a.paperId, a.sha256])).rows[0];
    if (existing) return { id: existing.id, created: false };
    const id = (await tx.query<{ id: string }>(
      'INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, original_name, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [a.paperId, `figure-file:${a.sha256}`, a.sha256, a.byteSize, a.media, a.name, a.ownerId])).rows[0]!.id;
    await tx.query("INSERT INTO asset_sources (asset_revision_id, paper_id, owner_id, kind, source, inspected_with) VALUES ($1, $2, $3, 'figure_file', 'user_upload', $4)", [id, a.paperId, a.ownerId, INSPECTOR_VERSION]);
    // the owner's own result file: kept on that basis; sending it anywhere is still the owner's decision
    await tx.query("INSERT INTO asset_policy_revisions (asset_revision_id, paper_id, license, keep_right, external_send, decided_by) VALUES ($1, $2, 'unknown', 'user_supplied', 'unknown', $3)", [id, a.paperId, a.ownerId]);
    return { id, created: true };
  });
}

// ---- versions -----------------------------------------------------------------------------------
export interface Panel { panel: string; unit: string; groups: string[]; description: string }
export interface FigureVersion { id: string; figure_id: string; version_no: number; caption: string; panels: Panel[]; asset_revision_id: string | null; created_at: string }

const PANEL_KEYS = ['panel', 'unit', 'groups', 'description'];
function str(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw new DomainError('INVALID', `${field} is required`, field);
    return '';
  }
  if (typeof v !== 'string' || v.length > max || !storable(v)) throw new DomainError('INVALID', `${field} must be text up to ${max} characters`, field);
  return v.trim();
}
export function parsePanels(raw: unknown): Panel[] {
  if (!Array.isArray(raw) || raw.length > 26) throw new DomainError('INVALID', 'panels must be a list of up to 26 panels', 'panels');
  const seen = new Set<string>();
  return raw.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof x !== 'object' || Array.isArray(x)) throw new DomainError('INVALID', `panels[${i}] must be an object`, 'panels');
    const extra = Object.keys(o).filter((k) => !PANEL_KEYS.includes(k));
    if (extra.length) throw new DomainError('INVALID', `panels[${i}] has unknown fields: ${extra.join(', ').slice(0, 80)}`, 'panels');
    const panel = str(o.panel, `panels[${i}].panel`, 10, true);
    if (!panel) throw new DomainError('INVALID', `panels[${i}].panel is required`, 'panels');
    if (seen.has(panel)) throw new DomainError('INVALID', `panel ${panel} appears twice`, 'panels');
    seen.add(panel);
    if (o.groups !== undefined && (!Array.isArray(o.groups) || o.groups.length > 50)) throw new DomainError('INVALID', `panels[${i}].groups must be a list`, 'panels');
    const groups = ((o.groups ?? []) as unknown[]).map((g, j) => str(g, `panels[${i}].groups[${j}]`, 100, true));
    return { panel, unit: str(o.unit, `panels[${i}].unit`, 50), groups, description: str(o.description, `panels[${i}].description`, 500) };
  });
}

// What changed between two versions, as machine-readable reasons ("unit_changed:A" …).
export function versionChanges(prev: Pick<FigureVersion, 'caption' | 'panels' | 'asset_revision_id'>, next: Pick<FigureVersion, 'caption' | 'panels' | 'asset_revision_id'>): string[] {
  const reasons: string[] = [];
  if (prev.asset_revision_id !== next.asset_revision_id) reasons.push('new_file');
  if (prev.caption !== next.caption) reasons.push('caption_changed');
  const before = new Map(prev.panels.map((p) => [p.panel, p]));
  const after = new Map(next.panels.map((p) => [p.panel, p]));
  for (const [k, p] of before) {
    const q = after.get(k);
    if (!q) { reasons.push(`panel_removed:${k}`); continue; }
    if (p.unit !== q.unit) reasons.push(`unit_changed:${k}`);
    if (JSON.stringify(p.groups) !== JSON.stringify(q.groups)) reasons.push(`groups_changed:${k}`);
  }
  for (const k of after.keys()) if (!before.has(k)) reasons.push(`panel_added:${k}`);
  return reasons;
}

interface DocNode { type?: string; attrs?: Record<string, unknown>; content?: DocNode[] }
function blocksMentioning(doc: DocNode, figureId: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const has = (n: DocNode): boolean => (n.type === 'figure_ref' && n.attrs?.targetId === figureId) || (n.content ?? []).some(has);
  const text = (n: DocNode): string => (n.type === 'text' ? String((n as { text?: string }).text ?? '') : (n.content ?? []).map(text).join(''));
  const walk = (n: DocNode) => {
    if (typeof n.attrs?.id === 'string' && ['paragraph', 'heading', 'table'].includes(String(n.type))) {
      if (has(n)) out.push({ id: n.attrs.id, text: text(n).slice(0, 200) });
      return;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

export async function addFigureVersion(pool: TxPool, a: { paperId: string; ownerId: string; figureId: string; body: unknown }) {
  if (!UUID_RE.test(a.figureId)) throw new DomainError('NOT_FOUND', 'figure not found');
  const b = (a.body ?? {}) as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !['caption', 'panels', 'asset_id'].includes(k));
  if (extra.length) throw new DomainError('INVALID', `unknown fields: ${extra.join(', ').slice(0, 100)}`, extra[0]);
  const caption = str(b.caption, 'caption', 5000);
  const panels = parsePanels(b.panels ?? []);
  const assetId = b.asset_id === undefined || b.asset_id === null ? null : String(b.asset_id);
  if (assetId !== null && !UUID_RE.test(assetId)) throw new DomainError('INVALID', 'asset_id must be an asset id', 'asset_id');
  return inTransaction(pool, async (tx) => {
    const fig = (await tx.query<{ id: string; archived_at: string | null }>('SELECT id, archived_at FROM figure_objects WHERE paper_id = $1 AND id = $2 FOR UPDATE', [a.paperId, a.figureId])).rows[0];
    if (!fig || fig.archived_at) throw new DomainError('NOT_FOUND', 'figure not found');
    if (assetId && !(await tx.query('SELECT 1 FROM asset_revisions WHERE paper_id = $1 AND id = $2', [a.paperId, assetId])).rowCount) throw new DomainError('NOT_FOUND', 'file not found in this paper', 'asset_id');
    const prev = (await tx.query<FigureVersion>('SELECT id, figure_id, version_no, caption, panels, asset_revision_id, created_at FROM figure_versions WHERE figure_id = $1 ORDER BY version_no DESC LIMIT 1', [a.figureId])).rows[0];
    const next = { caption, panels, asset_revision_id: assetId };
    const reasons = prev ? versionChanges(prev, next) : [];
    if (prev && !reasons.length) throw new DomainError('CONFLICT', 'nothing changed: this is the current version', undefined, { details: { reason: 'unchanged' } });
    const v = (await tx.query<FigureVersion>(
      'INSERT INTO figure_versions (paper_id, figure_id, version_no, caption, panels, asset_revision_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, figure_id, version_no, caption, panels, asset_revision_id, created_at',
      [a.paperId, a.figureId, (prev?.version_no ?? 0) + 1, caption, JSON.stringify(panels), assetId, a.ownerId])).rows[0]!;
    const flags: { target_kind: string; reasons: string[] }[] = [];
    if (prev) {
      const flag = async (target: { kind: 'paragraph'; documentId: string; blockId: string } | { kind: 'claim'; claimId: string } | { kind: 'fact'; factId: string }, why: string[]) => {
        await tx.query(
          `INSERT INTO figure_review_flags (paper_id, figure_id, from_version_id, to_version_id, target_kind, document_id, block_id, claim_id, fact_id, reasons)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [a.paperId, a.figureId, prev.id, v.id, target.kind, target.kind === 'paragraph' ? target.documentId : null, target.kind === 'paragraph' ? target.blockId : null,
            target.kind === 'claim' ? target.claimId : null, target.kind === 'fact' ? target.factId : null, why]);
        flags.push({ target_kind: target.kind, reasons: why });
      };
      // paragraphs of the manuscript (current revision) that mention the figure
      const docs = (await tx.query<{ id: string; content_json: DocNode }>(
        "SELECT d.id, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1 AND d.kind = 'manuscript'", [a.paperId])).rows;
      for (const d of docs) for (const blk of blocksMentioning(d.content_json, a.figureId)) await flag({ kind: 'paragraph', documentId: d.id, blockId: blk.id }, reasons);
      // claims relying on evidence from this figure
      const claims = (await tx.query<{ id: string }>(
        `SELECT DISTINCT c.id FROM claims c JOIN claim_evidence_links l ON l.claim_id = c.id JOIN figure_evidence_links f ON f.evidence_id = l.evidence_id
         WHERE c.paper_id = $1 AND f.figure_id = $2 AND c.approval_state IN ('DRAFT', 'APPROVED') ORDER BY c.id`, [a.paperId, a.figureId])).rows;
      for (const c of claims) await flag({ kind: 'claim', claimId: c.id }, reasons);
      // facts read from a panel that changed (or from any panel when the file changed)
      const facts = (await tx.query<{ id: string; unit: string; panel: string }>(
        `SELECT fr.id, fr.unit, f.panel FROM fact_records fr JOIN figure_evidence_links f ON f.evidence_id = fr.evidence_id
         WHERE fr.paper_id = $1 AND f.figure_id = $2 AND fr.verification_state IN ('CANDIDATE', 'VERIFIED') ORDER BY fr.id`, [a.paperId, a.figureId])).rows;
      const nextPanels = new Map(panels.map((p) => [p.panel, p]));
      for (const f of facts) {
        const why = reasons.filter((r) => r === 'new_file' || r.endsWith(`:${f.panel}`));
        const np = nextPanels.get(f.panel);
        if (np && np.unit && f.unit !== np.unit) why.push(`fact_unit_differs:${f.panel}`);
        if (why.length) await flag({ kind: 'fact', factId: f.id }, why);
      }
    }
    return { version: v, changes: reasons, flags };
  });
}

export async function listFigureVersions(db: Queryable, paperId: string, figureId: string): Promise<FigureVersion[]> {
  if (!UUID_RE.test(figureId)) return [];
  return (await db.query<FigureVersion>('SELECT id, figure_id, version_no, caption, panels, asset_revision_id, created_at FROM figure_versions WHERE paper_id = $1 AND figure_id = $2 ORDER BY version_no', [paperId, figureId])).rows;
}

// Evidence read from a figure/table version (and panel). The evidence must be a figure panel or a
// table cell of this paper, read from that version's file.
export async function linkFigureEvidence(pool: TxPool, a: { paperId: string; ownerId: string; evidenceId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (!UUID_RE.test(a.evidenceId)) throw new DomainError('NOT_FOUND', 'evidence not found');
  if (typeof b.figure_version_id !== 'string' || !UUID_RE.test(b.figure_version_id)) throw new DomainError('INVALID', 'figure_version_id is required', 'figure_version_id');
  const panel = str(b.panel, 'panel', 50);
  return inTransaction(pool, async (tx) => {
    const ev = (await tx.query<{ kind: string; source_asset_revision_id: string | null }>('SELECT kind, source_asset_revision_id FROM evidence_records WHERE paper_id = $1 AND id = $2', [a.paperId, a.evidenceId])).rows[0];
    if (!ev) throw new DomainError('NOT_FOUND', 'evidence not found');
    if (!['figure_panel', 'table_cell'].includes(ev.kind)) throw new DomainError('INVALID', 'only figure-panel or table-cell evidence is read from a figure/table', 'evidence');
    const v = (await tx.query<FigureVersion>('SELECT id, figure_id, version_no, caption, panels, asset_revision_id, created_at FROM figure_versions WHERE paper_id = $1 AND id = $2', [a.paperId, b.figure_version_id])).rows[0];
    if (!v) throw new DomainError('NOT_FOUND', 'figure version not found', 'figure_version_id');
    if (v.asset_revision_id !== ev.source_asset_revision_id) throw new DomainError('CONFLICT', 'the evidence was not read from this version\'s file', 'figure_version_id', { details: { reason: 'different_file' } });
    if (panel && !v.panels.some((p) => p.panel === panel)) throw new DomainError('INVALID', `this version has no panel ${panel}`, 'panel');
    const r = await tx.query('INSERT INTO figure_evidence_links (evidence_id, paper_id, figure_id, figure_version_id, panel, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
      [a.evidenceId, a.paperId, v.figure_id, v.id, panel, a.ownerId]);
    if (!r.rowCount) throw new DomainError('CONFLICT', 'this evidence is already linked to a figure/table');
    return { evidence_id: a.evidenceId, figure_id: v.figure_id, figure_version_id: v.id, version_no: v.version_no, panel };
  });
}

// ---- tracing ------------------------------------------------------------------------------------
async function figureNumbers(db: Queryable, paperId: string) {
  const rows = (await db.query<{ id: string; kind: string; title: string; position: number }>('SELECT id, kind, title, position FROM figure_objects WHERE paper_id = $1 AND archived_at IS NULL ORDER BY kind, position, id', [paperId])).rows;
  const out = new Map<string, { kind: string; title: string; number: number }>();
  for (const kind of ['figure', 'table']) rows.filter((r) => r.kind === kind).forEach((r, i) => out.set(r.id, { kind: r.kind, title: r.title, number: i + 1 }));
  return out;
}

export async function traceClaim(db: Queryable, paperId: string, claimId: string) {
  if (!UUID_RE.test(claimId)) throw new DomainError('NOT_FOUND', 'claim not found');
  const claim = (await db.query<{ id: string; kind: string; text: string; approval_state: string }>('SELECT id, kind, text, approval_state FROM claims WHERE paper_id = $1 AND id = $2', [paperId, claimId])).rows[0];
  if (!claim) throw new DomainError('NOT_FOUND', 'claim not found');
  const numbers = await figureNumbers(db, paperId);
  const links = (await db.query<{ relation: string; evidence_id: string; kind: string; label: string; locator: Record<string, unknown>; extraction_state: string; source_asset_revision_id: string | null; reference_id: string | null }>(
    `SELECT l.relation, e.id AS evidence_id, e.kind, e.label, e.locator, e.extraction_state, e.source_asset_revision_id, e.reference_id
     FROM claim_evidence_links l JOIN evidence_records e ON e.id = l.evidence_id WHERE l.paper_id = $1 AND l.claim_id = $2 ORDER BY l.created_at, e.id`, [paperId, claimId])).rows;
  const out = [];
  for (const l of links) {
    const fig = (await db.query<{ figure_id: string; figure_version_id: string; panel: string; version_no: number; panels: Panel[]; current_version_no: number }>(
      `SELECT f.figure_id, f.figure_version_id, f.panel, v.version_no, v.panels, (SELECT max(version_no) FROM figure_versions WHERE figure_id = f.figure_id) AS current_version_no
       FROM figure_evidence_links f JOIN figure_versions v ON v.id = f.figure_version_id WHERE f.evidence_id = $1`, [l.evidence_id])).rows[0];
    const panel = fig?.panels.find((p) => p.panel === fig.panel) ?? null;
    const facts = (await db.query<{ id: string; entity: string; metric: string; value_text: string; unit: string; group_label: string; comparison: string; n: number | null; verification_state: string }>(
      'SELECT id, entity, metric, value_text, unit, group_label, comparison, n, verification_state FROM fact_records WHERE paper_id = $1 AND evidence_id = $2 ORDER BY created_at, id', [paperId, l.evidence_id])).rows;
    const anchorId = typeof l.locator.anchor_id === 'string' && UUID_RE.test(l.locator.anchor_id) ? l.locator.anchor_id : null;
    const anchor = anchorId ? (await db.query<{ id: string; asset_revision_id: string; sha256: string; page_index: number; exact: string }>(
      'SELECT id, asset_revision_id, sha256, page_index, exact FROM pdf_anchors WHERE paper_id = $1 AND id = $2', [paperId, anchorId])).rows[0] ?? null : null;
    out.push({
      relation: l.relation,
      evidence: { id: l.evidence_id, kind: l.kind, label: l.label, state: l.extraction_state, locator: l.locator, source_asset_revision_id: l.source_asset_revision_id, reference_id: l.reference_id },
      figure: fig ? {
        id: fig.figure_id, ...(numbers.get(fig.figure_id) ?? { kind: 'figure', title: '(archived)', number: null }), version_no: fig.version_no, current_version_no: fig.current_version_no,
        outdated: fig.version_no !== fig.current_version_no, panel: fig.panel, unit: panel?.unit ?? null, groups: panel?.groups ?? [],
      } : null,
      source_location: anchor,
      facts: facts.map((f) => ({ ...f, unit_matches_panel: panel ? (panel.unit === '' || panel.unit === f.unit) : null })),
    });
  }
  const flags = (await db.query('SELECT id, figure_id, reasons, created_at FROM figure_review_flags WHERE paper_id = $1 AND claim_id = $2 AND status = \'open\' ORDER BY created_at', [paperId, claimId])).rows;
  return { claim, links: out, open_flags: flags };
}

export interface ReviewFlag { id: string; figure_id: string; target_kind: string; document_id: string | null; block_id: string | null; claim_id: string | null; fact_id: string | null; reasons: string[]; status: string; from_version_no: number; to_version_no: number; created_at: string }
export async function listReviewFlags(db: Queryable, paperId: string, opts: { status?: 'open' | 'all' } = {}): Promise<ReviewFlag[]> {
  return (await db.query<ReviewFlag>(
    `SELECT f.id, f.figure_id, f.target_kind, f.document_id, f.block_id, f.claim_id, f.fact_id, f.reasons, f.status, a.version_no AS from_version_no, b.version_no AS to_version_no, f.created_at
     FROM figure_review_flags f JOIN figure_versions a ON a.id = f.from_version_id JOIN figure_versions b ON b.id = f.to_version_id
     WHERE f.paper_id = $1 ${opts.status === 'all' ? '' : "AND f.status = 'open'"} ORDER BY f.created_at, f.id`, [paperId])).rows;
}

export async function resolveReviewFlag(pool: TxPool, a: { paperId: string; ownerId: string; flagId: string; body: unknown }) {
  if (!UUID_RE.test(a.flagId)) throw new DomainError('NOT_FOUND', 'review flag not found');
  const note = str(((a.body ?? {}) as Record<string, unknown>).note, 'note', 1000);
  const r = await pool.query("UPDATE figure_review_flags SET status = 'resolved', resolution_note = $3, resolved_by = $4, resolved_at = clock_timestamp() WHERE id = $1 AND paper_id = $2 AND status = 'open'",
    [a.flagId, a.paperId, note || null, a.ownerId]);
  if (!r.rowCount) throw new DomainError('NOT_FOUND', 'review flag not found or already resolved');
  return { id: a.flagId, status: 'resolved' };
}

