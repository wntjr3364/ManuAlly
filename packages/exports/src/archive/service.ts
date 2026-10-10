// The source archive as an export record (PW-057). Read from a named snapshot only: its documents' pinned
// revisions, the story and outline revisions it pins (their immutable content; node approvals given by then),
// its reference revisions, its figures with the captions they had at the snapshot, the writing profile approved
// at the snapshot, the AI proposals applied by then (the assistance audit), and its asset revisions with each
// one's current licence. Originals are read from the content-addressed store only when the purpose takes
// them; a missing or damaged one makes the archive 'incomplete'. The archive is verified by its own verifier
// before it is stored; its bytes go to the asset store and the record keeps their hash.
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import { defaultAssetDir, IntegrityError, putBlob, readVerified } from '@pw/domain/asset-policy/store.ts';
import { getExport, retractedOf, type ExportRecord } from '../docx/service.ts';
import { ARCHIVE_ZIP_LIMITS, buildArchive, shareable, verifyArchive, type ArchiveAsset, type ArchivePurpose } from './index.ts';

const PURPOSES: readonly ArchivePurpose[] = ['share', 'private'];

async function snapshotData(db: Queryable, paperId: string, snapshotId: string) {
  const snap = (await db.query<{ id: string; label: string; created_at: Date; story_revision_id: string | null; outline_revision_id: string | null; citation_style: string; style_version: string }>(
    'SELECT id, label, created_at, story_revision_id, outline_revision_id, citation_style, style_version FROM paper_snapshots WHERE id = $1 AND paper_id = $2', [snapshotId, paperId])).rows[0];
  if (!snap) throw new DomainError('NOT_FOUND', 'snapshot not found');
  const at = snap.created_at;
  const paper = (await db.query<{ id: string; title: string }>('SELECT id, working_title AS title FROM paper_projects WHERE id = $1', [paperId])).rows[0]!;
  const documents = (await db.query<{ document_id: string; kind: string; revision_id: string; schema_version: number; content: unknown }>(
    `SELECT s.document_id, d.kind, s.revision_id, r.schema_version, r.content_json AS content FROM snapshot_document_revisions s
     JOIN documents d ON d.id = s.document_id AND d.paper_id = s.paper_id JOIN document_revisions r ON r.id = s.revision_id AND r.paper_id = s.paper_id
     WHERE s.snapshot_id = $1 AND s.paper_id = $2 ORDER BY s.document_id`, [snapshotId, paperId])).rows;
  const story = snap.story_revision_id ? (await db.query(
    'SELECT id AS revision_id, parent_revision_id, brief, story, content_hash, approved_by, approved_at FROM story_revisions WHERE id = $1 AND paper_id = $2', [snap.story_revision_id, paperId])).rows[0] ?? null : null;
  let outline: Record<string, unknown> | null = null;
  if (snap.outline_revision_id) {
    outline = (await db.query('SELECT id AS revision_id, story_revision_id, parent_revision_id, content_hash, approved_by, approved_at FROM outline_revisions WHERE id = $1 AND paper_id = $2', [snap.outline_revision_id, paperId])).rows[0] ?? null;
    if (outline) {
      outline.nodes = (await db.query(
        `SELECT n.node_id, n.parent_node_id, n.position, n.section, n.role, n.paragraph_goal, n.claim_ids, n.evidence_ids, n.requires_evidence, n.allowed_interpretation,
                n.exclusions, n.transition, n.word_budget_min, n.word_budget_max, a.content_hash AS approved_content_hash, a.approved_by, a.approved_at
         FROM outline_nodes n LEFT JOIN outline_node_approvals a ON a.outline_revision_id = n.outline_revision_id AND a.node_id = n.node_id AND a.approved_at <= $3
         WHERE n.outline_revision_id = $1 AND n.paper_id = $2 ORDER BY n.position, n.node_id`, [snap.outline_revision_id, paperId, at])).rows;
    }
  }
  const references = (await db.query<{ reference_id: string; bibliographic_revision_id: string; csl: Record<string, unknown> }>(
    `SELECT s.reference_id, s.bibliographic_revision_id, b.csl_json AS csl FROM snapshot_reference_revisions s JOIN bibliographic_revisions b ON b.id = s.bibliographic_revision_id
     WHERE s.snapshot_id = $1 AND s.paper_id = $2 ORDER BY s.reference_id`, [snapshotId, paperId])).rows;
  const figures = (await db.query<{ id: string; kind: 'figure' | 'table'; position: number; title: string; caption: string | null }>(
    `SELECT f.figure_id AS id, f.kind, f.position, f.title,
            (SELECT nullif(btrim(v.caption), '') FROM figure_versions v WHERE v.figure_id = f.figure_id AND v.paper_id = f.paper_id AND v.created_at <= $3 ORDER BY v.version_no DESC LIMIT 1) AS caption
     FROM snapshot_figures f WHERE f.snapshot_id = $1 AND f.paper_id = $2 ORDER BY f.kind, f.position, f.figure_id`, [snapshotId, paperId, at])).rows;
  const assets = (await db.query<Omit<ArchiveAsset, 'bytes'>>(
    `SELECT a.id AS asset_revision_id, coalesce(s.kind, 'other') AS kind, a.sha256, a.byte_size::float8 AS byte_size, a.media_type, a.original_name, s.source_url,
            coalesce(p.license, 'unknown') AS license, coalesce(p.keep_right, 'unknown') AS keep_right
     FROM snapshot_asset_revisions x JOIN asset_revisions a ON a.id = x.asset_revision_id AND a.paper_id = x.paper_id
     LEFT JOIN asset_sources s ON s.asset_revision_id = a.id
     LEFT JOIN LATERAL (SELECT license, keep_right FROM asset_policy_revisions q WHERE q.asset_revision_id = a.id ORDER BY q.created_at DESC, q.id DESC LIMIT 1) p ON true
     WHERE x.snapshot_id = $1 AND x.paper_id = $2 ORDER BY a.id`, [snapshotId, paperId])).rows;
  const profile = (await db.query(
    `SELECT id AS revision_id, content_hash, content, approved_at FROM writing_profile_revisions
     WHERE paper_id = $1 AND approved_at IS NOT NULL AND approved_at <= $2 AND (superseded_at IS NULL OR superseded_at > $2) ORDER BY approved_at DESC LIMIT 1`, [paperId, at])).rows[0] ?? null;
  const aiAudit = (await db.query(
    `SELECT 'selection_edit' AS kind, id AS proposal_id, document_id, base_revision_id, applied_revision_id, outline_revision_id, intent AS mode, origin AS generator, proposal_hash, decided_by, decided_at
       FROM edit_proposals WHERE paper_id = $1 AND status = 'APPLIED' AND decided_at <= $2
     UNION ALL
     SELECT 'paragraph', id, document_id, base_revision_id, applied_revision_id, outline_revision_id, mode, generator, proposal_hash, decided_by, decided_at
       FROM paragraph_proposals WHERE paper_id = $1 AND status = 'APPLIED' AND decided_at <= $2
     ORDER BY decided_at, proposal_id`, [paperId, at])).rows;
  return { snap, paper, documents, story, outline, references, figures, assets, profile, aiAudit };
}

// `verify` is the archive's own verifier (replaceable in tests, to show that an archive it does not accept is
// never stored as passed)
export async function createArchiveExport(pool: TxPool, a: { paperId: string; ownerId: string; snapshotId: unknown; purpose: unknown; assetDir?: string; now?: Date }, verify: typeof verifyArchive = verifyArchive): Promise<ExportRecord> {
  if (!PURPOSES.includes(a.purpose as ArchivePurpose)) throw new DomainError('INVALID', 'purpose must be share (for others: only originals whose licence allows it) or private (your own copy)', 'purpose');
  if (typeof a.snapshotId !== 'string' || !UUID_RE.test(a.snapshotId)) throw new DomainError('NOT_FOUND', 'snapshot not found');
  const purpose = a.purpose as ArchivePurpose;
  const dir = a.assetDir ?? defaultAssetDir();
  const d = await snapshotData(pool, a.paperId, a.snapshotId);
  // only the originals this purpose takes are read
  const notShareable = new Set(d.assets.filter((x) => !shareable(x.license)).map((x) => x.sha256));
  const taken = d.assets.filter((x) => purpose === 'private' || (shareable(x.license) && !notShareable.has(x.sha256)));
  const total = taken.reduce((n, x) => n + Number(x.byte_size), 0);
  if (total > ARCHIVE_ZIP_LIMITS.totalUnpacked / 2) throw new DomainError('INVALID', `the originals come to ${Math.round(total / 1048576)} MiB, more than an archive holds (${ARCHIVE_ZIP_LIMITS.totalUnpacked / 2 / 1048576} MiB)`, 'purpose');
  const assets: ArchiveAsset[] = [];
  for (const x of d.assets) {
    if (!taken.includes(x)) { assets.push({ ...x, bytes: null }); continue; }
    try {
      assets.push({ ...x, bytes: await readVerified(dir, x.sha256) });
    } catch (e) {
      if (!(e instanceof IntegrityError)) throw e;
      assets.push({ ...x, bytes: null, store_error: /does not match/.test(e.message) ? 'damaged' : 'missing' });
    }
  }
  const retracted = [...(await retractedOf(pool, a.ownerId, d.references.map((r) => r.reference_id)))];
  const built = buildArchive({
    purpose, createdAt: (a.now ?? new Date()).toISOString(), paper: d.paper,
    snapshot: { ...d.snap, created_at: new Date(d.snap.created_at).toISOString() },
    documents: d.documents, story: d.story, outline: d.outline, references: d.references, figures: d.figures, assets, retracted, profile: d.profile, aiAudit: d.aiAudit,
  });
  const check = verify(built.bytes);
  const manuscript = built.manifest.render;
  let docxStatus: 'clean' | 'needs_attention' | 'draft_with_errors' = 'clean';
  if (manuscript) {
    const f = built.manifest.files.find((x) => x.path === 'outputs/manuscript.docx.report.json');
    docxStatus = f ? JSON.parse(readEntry(built.bytes, f.path)).status : 'clean';
  }
  // never shown as complete: missing originals, or an archive its own verifier does not accept
  const status = built.manifest.status === 'incomplete' ? 'incomplete' : !check.ok ? 'draft_with_errors' : docxStatus;
  const report = {
    status, purpose, snapshot: { id: d.snap.id, label: d.snap.label }, files: built.manifest.files.length,
    excluded: built.manifest.excluded, missing: built.manifest.missing, problems: built.manifest.problems,
    verification: { ok: check.ok, status: check.status, reproduced: check.reproduced, problems: check.problems.slice(0, 20) },
    versions: built.manifest.versions,
  };
  const sha = await putBlob(dir, built.bytes);
  const id = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    return (await tx.query<{ id: string }>(
      `INSERT INTO exports (paper_id, document_id, revision_id, snapshot_id, purpose, format, status, style, style_version, renderer_version, report_json, file_bytes, in_asset_store, sha256, byte_size, created_by)
       VALUES ($1, $2, $3, $4, $5, 'source_archive', $6, $7, $8, $9, $10, NULL, true, $11, $12, $13) RETURNING id`,
      [a.paperId, manuscript?.document_id ?? null, manuscript?.revision_id ?? null, d.snap.id, purpose, status, d.snap.citation_style, d.snap.style_version,
        built.manifest.versions.docx_renderer, JSON.stringify(report), sha, built.bytes.length, a.ownerId])).rows[0]!.id;
  });
  return (await getExport(pool, a.paperId, id))!;
}

import { openZip } from '@pw/domain/imports/docx/zip.ts';
const readEntry = (zip: Buffer, name: string) => openZip(zip, ARCHIVE_ZIP_LIMITS).read(name)!.toString('utf8');
