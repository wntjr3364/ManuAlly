// Reviewer comments, responses and frozen submissions (PW-058, spec 10 "Reviewer workflow" and
// "SubmissionSnapshot").
// - A comment is pasted by the owner and records the manuscript revision it was made on.
// - An answer that says the text was changed ('addressed', 'partly_addressed') must link to blocks of a
//   later revision of the same document (a descendant of the comment's revision) that really differ from the
//   comment's revision; otherwise it is refused. Other answers (disagree, explained, not addressed) carry no
//   links. Answers are kept; the latest counts.
// - checks(): what stands between a manuscript revision and "submission-ready". Blocking: the export check's
//   errors (unresolved citations and figure references — RFC-008 —, citation-like typed text, a DOCX that does
//   not read back), an unanswered comment, a claimed change no longer in the text, a failed scientific check or
//   an open scientific finding on a paragraph as it still stands. Warnings (the owner confirms them): the
//   export check's warnings, comments answered "not addressed", checks or findings on paragraphs changed since,
//   checks that could not decide.
// - freezeSubmission(): the owner's act. Checked first on the head (nothing is made when submission-ready is
//   refused); then a named snapshot and its private source archive (PW-057) are made, checked again on the
//   archive's own render, and the submission is stored once with the DOCX hash, the checks, the response
//   trace and the versions. Rendering, snapshots and archives are given by the caller (the exports package
//   depends on this one).
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../shared/db.ts';
import { contentHash } from '../revisions/index.ts';

export const RESPONSE_STATUSES = ['addressed', 'partly_addressed', 'disagree', 'explained', 'not_addressed'] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];
const CHANGED: readonly ResponseStatus[] = ['addressed', 'partly_addressed'];
export interface CheckItem { kind: string; count: number; examples: string[]; note: string }
export interface Checks { blocking: CheckItem[]; warnings: CheckItem[] }
export interface RenderReport { status: string; issues: { kind: string; severity: 'error' | 'warning'; count: number; examples: string[]; note: string }[] }
export interface Link { revision_id: string; block_id: string; change: 'changed' | 'added' | 'removed'; heading: string | null; before_hash: string | null; after_hash: string | null }

// ---- blocks of a stored revision -------------------------------------------------------------------------
type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Node[] };
const textOf = (n: Node): string => (n.type === 'text' ? n.text ?? '' : n.type === 'citation' ? '[cite]' : n.type === 'figure_ref' ? '[fig]' : (n.content ?? []).map(textOf).join(n.type === 'table_row' ? ' | ' : ''));
interface Block { hash: string; text: string; heading: string | null; paragraph: boolean }
export function blocksOf(content: unknown): Map<string, Block> {
  const out = new Map<string, Block>();
  let heading: string | null = null;
  for (const b of ((content as Node)?.content ?? [])) {
    const id = b.attrs?.id;
    if (b.type === 'heading') heading = textOf(b).trim() || heading;
    if (typeof id === 'string') out.set(id, { hash: contentHash(b), text: textOf(b).trim(), heading: b.type === 'heading' ? textOf(b).trim() : heading, paragraph: b.type === 'paragraph' });
  }
  return out;
}
const PLACEHOLDER = /\bTODO\b|\bTBD\b|\bFIXME\b|\?\?\?+|\[needs_input\]|\[citation needed\]|\[\s*\?\s*\]/gi;
const XX = /(?<![A-Za-z])XX(?![A-Za-z])/;
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function revisionContent(db: Queryable, paperId: string, documentId: string, revisionId: string): Promise<unknown | null> {
  if (!UUID_RE.test(revisionId)) return null;
  return (await db.query<{ content_json: unknown }>('SELECT content_json FROM document_revisions WHERE paper_id = $1 AND document_id = $2 AND id = $3', [paperId, documentId, revisionId])).rows[0]?.content_json ?? null;
}
// is `revisionId` a later revision of the same document descending from `baseId`?
async function descendsFrom(db: Queryable, paperId: string, documentId: string, revisionId: string, baseId: string): Promise<boolean> {
  if (revisionId === baseId) return false;
  const r = await db.query<{ found: boolean }>(
    `WITH RECURSIVE chain(id, parent, depth) AS (
       SELECT id, parent_revision_id, 0 FROM document_revisions WHERE paper_id = $1 AND document_id = $2 AND id = $3
       UNION ALL
       SELECT r.id, r.parent_revision_id, c.depth + 1 FROM document_revisions r JOIN chain c ON r.id = c.parent WHERE r.paper_id = $1 AND r.document_id = $2 AND c.depth < 100000
     ) SELECT EXISTS (SELECT 1 FROM chain WHERE id = $4) AS found`, [paperId, documentId, revisionId, baseId]);
  return r.rows[0]!.found;
}
async function head(db: Queryable, paperId: string, documentId: unknown): Promise<{ document_id: string; revision_id: string; content: unknown }> {
  if (typeof documentId !== 'string' || !UUID_RE.test(documentId)) throw new DomainError('NOT_FOUND', 'document not found');
  const h = (await db.query<{ revision_id: string; content: unknown }>(
    `SELECT r.id AS revision_id, r.content_json AS content FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id
     WHERE d.paper_id = $1 AND d.id = $2 AND d.kind = 'manuscript'`, [paperId, documentId])).rows[0];
  if (!h) throw new DomainError('NOT_FOUND', 'document not found');
  return { document_id: documentId, ...h };
}

// ---- comments ----------------------------------------------------------------------------------------------
export interface Comment { id: string; document_id: string; base_revision_id: string; round: string; reviewer: string; position: number; text: string; created_at: string }
const COMMENT = 'id, document_id, base_revision_id, round_label AS round, reviewer_label AS reviewer, position, body AS text, created_at';
const label = (v: unknown, field: string, max: number) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || !storable(v)) throw new DomainError('INVALID', `${field} must be 1–${max} characters`, field);
  return v.trim();
};
// a name on one line (labels end up in headings and table cells; review n1)
const line = (v: unknown, field: string, max: number) => {
  const x = label(v, field, max);
  // eslint-disable-next-line no-control-regex -- control characters are refused on purpose
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(x)) throw new DomainError('INVALID', `${field} must be a single line`, field);
  return x;
};

export async function addComment(pool: TxPool, a: { paperId: string; ownerId: string; body: unknown }): Promise<Comment> {
  const b = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  const round = line(b.round ?? 'R1', 'round', 40);
  const reviewer = line(b.reviewer, 'reviewer', 80);
  const text = label(b.text, 'text', 20000);
  return inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    await tx.query('SELECT 1 FROM paper_projects WHERE id = $1 FOR UPDATE', [a.paperId]);
    const h = await head(tx, a.paperId, b.document_id);
    return (await tx.query<Comment>(
      `INSERT INTO review_comments (paper_id, document_id, base_revision_id, round_label, reviewer_label, position, body, created_by)
       SELECT $1, $2, $3, $4, $5, coalesce(max(position), 0) + 1, $6, $7 FROM review_comments WHERE paper_id = $1
       RETURNING ${COMMENT}`, [a.paperId, h.document_id, h.revision_id, round, reviewer, text, a.ownerId])).rows[0]!;
  });
}

async function getComment(db: Queryable, paperId: string, commentId: string): Promise<Comment> {
  if (!UUID_RE.test(commentId)) throw new DomainError('NOT_FOUND', 'comment not found');
  const c = (await db.query<Comment>(`SELECT ${COMMENT} FROM review_comments WHERE paper_id = $1 AND id = $2`, [paperId, commentId])).rows[0];
  if (!c) throw new DomainError('NOT_FOUND', 'comment not found');
  return c;
}

// the blocks changed since the comment's revision, in the current head (to pick what an answer points to)
export async function commentChanges(db: Queryable, paperId: string, commentId: string) {
  const c = await getComment(db, paperId, commentId);
  const h = await head(db, paperId, c.document_id);
  const before = blocksOf(await revisionContent(db, paperId, c.document_id, c.base_revision_id));
  const after = blocksOf(h.content);
  const blocks: { block_id: string; change: Link['change']; heading: string | null; before: string | null; after: string | null }[] = [];
  for (const [id, x] of after) {
    const y = before.get(id);
    if (!y) blocks.push({ block_id: id, change: 'added', heading: x.heading, before: null, after: clip(x.text) });
    else if (y.hash !== x.hash) blocks.push({ block_id: id, change: 'changed', heading: x.heading, before: clip(y.text), after: clip(x.text) });
  }
  for (const [id, y] of before) if (!after.has(id)) blocks.push({ block_id: id, change: 'removed', heading: y.heading, before: clip(y.text), after: null });
  return { head_revision_id: h.revision_id, blocks };
}

// ---- responses ---------------------------------------------------------------------------------------------
export interface Response { id: string; comment_id: string; status: ResponseStatus; text: string; links: Link[]; created_at: string }
const RESPONSE = 'id, comment_id, status, body AS text, links, created_at';
const linkError = (reason: string, message: string) => new DomainError('INVALID', message, 'links', { details: { reason } });

async function checkLink(db: Queryable, paperId: string, c: Comment, raw: unknown, base: Map<string, Block>): Promise<Link> {
  const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof l.revision_id !== 'string' || typeof l.block_id !== 'string' || !UUID_RE.test(l.revision_id) || !l.block_id || l.block_id.length > 100) throw linkError('LINK_INVALID', 'each link needs a revision_id and a block_id');
  const content = await revisionContent(db, paperId, c.document_id, l.revision_id);
  if (content === null || !(await descendsFrom(db, paperId, c.document_id, l.revision_id, c.base_revision_id))) {
    throw linkError('LINK_NOT_AFTER_COMMENT', 'a link must point to a later revision of the commented document (made after the comment)');
  }
  const before = base.get(l.block_id);
  const after = blocksOf(content).get(l.block_id);
  if (before?.hash === after?.hash) throw linkError('LINK_NOT_A_CHANGE', 'the linked block is the same as when the comment was made — answer "addressed" only for text that was changed');
  return { revision_id: l.revision_id, block_id: l.block_id, change: !before ? 'added' : !after ? 'removed' : 'changed', heading: (after ?? before)!.heading, before_hash: before?.hash ?? null, after_hash: after?.hash ?? null };
}

export async function respond(pool: TxPool, a: { paperId: string; ownerId: string; commentId: string; body: unknown }): Promise<Response> {
  const b = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  if (!RESPONSE_STATUSES.includes(b.status as ResponseStatus)) throw new DomainError('INVALID', `status must be one of ${RESPONSE_STATUSES.join(', ')}`, 'status');
  const status = b.status as ResponseStatus;
  const text = typeof b.text === 'string' && b.text.length <= 20000 && storable(b.text) ? b.text : null;
  if (text === null) throw new DomainError('INVALID', 'text must be up to 20000 characters', 'text');
  const raw = b.links ?? [];
  if (!Array.isArray(raw) || raw.length > 20) throw linkError('LINK_INVALID', 'links must be a list of up to 20 links');
  if (CHANGED.includes(status) && raw.length === 0) throw linkError('LINK_REQUIRED', 'an answer saying the text was changed needs at least one link to a changed block');
  if (!CHANGED.includes(status) && raw.length > 0) throw linkError('LINK_NOT_ALLOWED', 'only an answer saying the text was changed carries links');
  const c = await getComment(pool, a.paperId, a.commentId);
  const base = blocksOf(await revisionContent(pool, a.paperId, c.document_id, c.base_revision_id));
  const links: Link[] = [];
  for (const l of raw) links.push(await checkLink(pool, a.paperId, c, l, base));
  return inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    return (await tx.query<Response>(`INSERT INTO review_responses (paper_id, comment_id, status, body, links, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${RESPONSE}`,
      [a.paperId, c.id, status, text, JSON.stringify(links), a.ownerId])).rows[0]!;
  });
}

// does each claimed change still differ from the comment's revision in `content`?
function holdsIn(content: unknown, base: Map<string, Block>, links: Link[]): { link: Link; holds: boolean }[] {
  const now = blocksOf(content);
  return links.map((link) => ({ link, holds: (base.get(link.block_id)?.hash ?? null) !== (now.get(link.block_id)?.hash ?? null) }));
}

interface Trace { comment: Comment; response: Response | null; links: { link: Link; holds: boolean }[] }
async function trace(db: Queryable, paperId: string, documentId: string, content: unknown): Promise<Trace[]> {
  const comments = (await db.query<Comment>(`SELECT ${COMMENT} FROM review_comments WHERE paper_id = $1 AND document_id = $2 ORDER BY position`, [paperId, documentId])).rows;
  const out: Trace[] = [];
  for (const c of comments) {
    const response = (await db.query<Response>(`SELECT ${RESPONSE} FROM review_responses WHERE paper_id = $1 AND comment_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [paperId, c.id])).rows[0] ?? null;
    const base = blocksOf(await revisionContent(db, paperId, documentId, c.base_revision_id));
    out.push({ comment: c, response, links: response ? holdsIn(content, base, response.links) : [] });
  }
  return out;
}

export async function listComments(db: Queryable, paperId: string) {
  const docs = (await db.query<{ id: string }>("SELECT DISTINCT document_id AS id FROM review_comments WHERE paper_id = $1", [paperId])).rows;
  const all: (Comment & { response: (Response & { holds_now: boolean | null }) | null })[] = [];
  for (const d of docs) {
    const h = await head(db, paperId, d.id);
    for (const t of await trace(db, paperId, d.id, h.content)) {
      all.push({ ...t.comment, response: t.response ? { ...t.response, holds_now: CHANGED.includes(t.response.status) ? t.links.every((x) => x.holds) : null } : null });
    }
  }
  return all.sort((x, y) => x.position - y.position);
}

// ---- checks ------------------------------------------------------------------------------------------------
const NOTE: Record<string, string> = {
  comment_without_response: '답하지 않은 리뷰어 의견이 있습니다',
  claimed_change_missing: '"수정했다"고 답한 곳이 지금 원고에서는 의견 당시 그대로입니다',
  comment_not_addressed: '"반영하지 않음"으로 답한 의견이 있습니다',
  scientific_check_failed: '과학 검사에 실패한 문단이 그대로 있습니다',
  scientific_check_stale: '과학 검사에 실패했던 문단이 그 뒤 바뀌었습니다 — 다시 검사하세요',
  scientific_check_unknown: '과학 검사가 판단하지 못한 문단이 있습니다',
  open_scientific_finding: '결정하지 않은 과학 검토 지적이 그대로인 문단에 있습니다',
  open_finding_stale: '결정하지 않은 검토 지적이 있던 문단이 그 뒤 바뀌었습니다',
  open_writing_finding: '결정하지 않은 글쓰기 검토 지적이 있습니다',
  scientific_check_not_run: '과학 검사를 하지 않았거나 검사 뒤 바뀐 문단이 있습니다(통과로 치지 않습니다)',
  placeholder_text: '채워 넣지 않은 자리표시(TODO, TBD, ???, [needs_input] 등)가 남아 있습니다',
  placeholder_like_xx: '"XX"가 있습니다 — 채워 넣을 자리인지 확인하세요(염색체 표기 등이면 그대로 두세요)',
  consistency_not_checked: '전체 일관성(초록↔결과 수치·결론, Methods↔분석, 약어 첫 정의, 자금·저자 기여·데이터 가용성 문단)은 앱이 검사하지 않았습니다 — 직접 확인하세요',
  archive_incomplete: '원본 묶음에 빠진 원본이 있습니다',
  archive_unverified: '원본 묶음이 자체 검증을 통과하지 못했습니다',
};
class Collect {
  private m = new Map<string, CheckItem>();
  add(kind: string, example?: string, note?: string, n = 1) {
    const x = this.m.get(kind) ?? { kind, count: 0, examples: [], note: note ?? NOTE[kind] ?? kind };
    x.count += n;
    if (example !== undefined && x.examples.length < 5 && !x.examples.includes(example)) x.examples.push(example);
    this.m.set(kind, x);
  }
  list() { return [...this.m.values()]; }
}

export async function checks(db: Queryable, a: { paperId: string; documentId: string; content: unknown; report: RenderReport }): Promise<Checks> {
  const blocking = new Collect();
  const warnings = new Collect();
  for (const i of a.report.issues) for (let k = 0; k < Math.max(1, i.examples.length); k++) (i.severity === 'error' ? blocking : warnings).add(i.kind, i.examples[k], i.note, k === 0 ? i.count : 0);
  const now = blocksOf(a.content);
  const name = (c: Comment) => `${c.round} ${c.reviewer} #${c.position}`;
  for (const t of await trace(db, a.paperId, a.documentId, a.content)) {
    if (!t.response) blocking.add('comment_without_response', name(t.comment));
    else if (t.links.some((x) => !x.holds)) blocking.add('claimed_change_missing', name(t.comment));
    else if (t.response.status === 'not_addressed') warnings.add('comment_not_addressed', name(t.comment));
  }
  // the block as a run read it, against the block now
  const cache = new Map<string, Map<string, Block>>();
  const asRead = async (revisionId: string, blockId: string) => {
    if (!cache.has(revisionId)) cache.set(revisionId, blocksOf(await revisionContent(db, a.paperId, a.documentId, revisionId)));
    return cache.get(revisionId)!.get(blockId)?.hash ?? null;
  };
  const runs = new Map((await db.query<{ block_id: string; revision_id: string; status: string }>(
    `SELECT DISTINCT ON (block_id) block_id, revision_id, status FROM scientific_check_runs WHERE paper_id = $1 AND document_id = $2 ORDER BY block_id, created_at DESC, id DESC`, [a.paperId, a.documentId])).rows.map((r) => [r.block_id, r]));
  // every paragraph as it stands: a check that failed on this wording blocks; never checked, or checked on
  // other wording, or undecided, is not a pass (review m1)
  for (const [id, cur] of now) {
    if (!cur.paragraph || !cur.text) continue;
    const r = runs.get(id);
    const where = clip(cur.text, 80);
    const same = r ? (await asRead(r.revision_id, id)) === cur.hash : false;
    if (r?.status === 'FAILED') (same ? blocking : warnings).add(same ? 'scientific_check_failed' : 'scientific_check_stale', where);
    else if (r?.status === 'UNKNOWN' && same) warnings.add('scientific_check_unknown', where);
    else if (!r || !same) warnings.add('scientific_check_not_run', where);
  }
  // text left to fill in (review m2)
  for (const cur of now.values()) {
    for (const m of cur.text.match(PLACEHOLDER) ?? []) blocking.add('placeholder_text', m);
    if (XX.test(cur.text)) warnings.add('placeholder_like_xx', clip(cur.text, 80));
  }
  const findings = (await db.query<{ kind: string; block_id: string; revision_id: string; quote: string }>(
    `SELECT f.kind, r.block_id, r.revision_id, f.quote FROM review_findings f JOIN review_runs r ON r.id = f.run_id AND r.paper_id = f.paper_id
     WHERE f.paper_id = $1 AND r.document_id = $2 AND f.decision = 'open' ORDER BY r.created_at, f.position`, [a.paperId, a.documentId])).rows;
  for (const f of findings) {
    const cur = now.get(f.block_id);
    if (!cur) continue;
    const same = (await asRead(f.revision_id, f.block_id)) === cur.hash;
    if (!same) warnings.add('open_finding_stale', clip(f.quote, 80));
    else (f.kind === 'scientific' ? blocking : warnings).add(f.kind === 'scientific' ? 'open_scientific_finding' : 'open_writing_finding', clip(f.quote, 80));
  }
  // what the app does not check is said, every time (spec 10 "전체 일관성 검사"; review m2)
  warnings.add('consistency_not_checked');
  return { blocking: blocking.list(), warnings: warnings.list() };
}

export async function checkHead(db: Queryable, a: { paperId: string; documentId: unknown }, render: (h: { document_id: string; revision_id: string; content: unknown }) => Promise<RenderReport>) {
  const h = await head(db, a.paperId, a.documentId);
  return { revision_id: h.revision_id, ...(await checks(db, { paperId: a.paperId, documentId: h.document_id, content: h.content, report: await render(h) })) };
}

// ---- freezing ----------------------------------------------------------------------------------------------
export interface FreezeDeps {
  render(h: { document_id: string; revision_id: string; content: unknown }): Promise<RenderReport>;
  snapshot(label: string): Promise<{ id: string }>;
  // the snapshot's private source archive: its export id, status, own verification, DOCX hash and render report
  archive(snapshotId: string): Promise<{ export_id: string; status: string; verified: boolean; docx_sha256: string; report: RenderReport; versions: Record<string, unknown> }>;
}
export interface Submission {
  id: string; label: string; target: string | null; status: 'draft' | 'submission_ready'; snapshot_id: string; archive_export_id: string; document_id: string; revision_id: string;
  docx_sha256: string; checks: Checks; responses: unknown[]; versions: Record<string, unknown>; confirmed_by: string; created_at: string;
}
const SUBMISSION = 'id, label, target, status, snapshot_id, archive_export_id, document_id, revision_id, docx_sha256, checks, responses, versions, confirmed_by, created_at';
const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) => new DomainError('CONFLICT', message, undefined, { details: { reason, ...details } });

export async function freezeSubmission(pool: TxPool, a: { paperId: string; ownerId: string; body: unknown }, deps: FreezeDeps): Promise<Submission> {
  const b = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  if (b.intent !== 'freeze_submission') throw new DomainError('INVALID', 'freezing needs the explicit intent "freeze_submission"', 'intent');
  if (b.status !== 'draft' && b.status !== 'submission_ready') throw new DomainError('INVALID', 'status must be draft or submission_ready', 'status');
  const ready = b.status === 'submission_ready';
  const name = line(b.label, 'label', 200);
  const target = b.target === undefined || b.target === null ? null : line(b.target, 'target', 200);
  // the warning kinds the owner saw and confirmed; a warning that was not shown is not confirmed (review m3)
  const confirmed = b.confirm_warnings ?? [];
  if (!Array.isArray(confirmed) || confirmed.length > 50 || confirmed.some((k) => typeof k !== 'string' || k.length > 60)) throw new DomainError('INVALID', 'confirm_warnings must be the list of warning kinds the owner confirmed', 'confirm_warnings');
  const h = await head(pool, a.paperId, b.document_id);
  if (b.expected_revision_id !== h.revision_id) throw refuse('STALE', 'the manuscript changed since it was checked; check again', { head_revision_id: h.revision_id });
  const gate = (c: Checks) => {
    if (ready && c.blocking.length) throw refuse('NOT_SUBMISSION_READY', '해결해야 할 문제가 있어 제출용으로 확정할 수 없습니다(초안으로는 확정할 수 있습니다)', { blocking: c.blocking, warnings: c.warnings });
    const unseen = c.warnings.filter((w) => !(confirmed as string[]).includes(w.kind));
    if (ready && unseen.length) throw refuse('CONFIRM_WARNINGS', '경고를 확인해야 제출용으로 확정할 수 있습니다', { warnings: c.warnings, unconfirmed: unseen.map((w) => w.kind) });
  };
  gate(await checks(pool, { paperId: a.paperId, documentId: h.document_id, content: h.content, report: await deps.render(h) }));
  // frozen: the snapshot pins the revisions; checked again on the archive's own render
  const snap = await deps.snapshot(`제출판: ${name}`.slice(0, 200));
  const pinned = (await pool.query<{ revision_id: string }>('SELECT revision_id FROM snapshot_document_revisions WHERE snapshot_id = $1 AND document_id = $2', [snap.id, h.document_id])).rows[0];
  if (pinned?.revision_id !== h.revision_id) throw refuse('STALE', 'the manuscript changed while freezing; check again');
  const arc = await deps.archive(snap.id);
  const final = await checks(pool, { paperId: a.paperId, documentId: h.document_id, content: h.content, report: arc.report });
  if (arc.status === 'incomplete') final.blocking.push({ kind: 'archive_incomplete', count: 1, examples: [], note: NOTE.archive_incomplete! });
  if (!arc.verified) final.blocking.push({ kind: 'archive_unverified', count: 1, examples: [], note: NOTE.archive_unverified! });
  gate(final);
  const responses = (await trace(pool, a.paperId, h.document_id, h.content)).map((t) => ({
    comment_id: t.comment.id, position: t.comment.position, round: t.comment.round, reviewer: t.comment.reviewer, comment: t.comment.text,
    response_id: t.response?.id ?? null, status: t.response?.status ?? null, response: t.response?.text ?? null,
    links: t.links.map((x) => ({ block_id: x.link.block_id, revision_id: x.link.revision_id, change: x.link.change, heading: x.link.heading, holds: x.holds })),
  }));
  const id = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    return (await tx.query<{ id: string }>(
      `INSERT INTO submissions (paper_id, label, target, status, snapshot_id, archive_export_id, document_id, revision_id, docx_sha256, checks, responses, versions, confirmed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [a.paperId, name, target, b.status, snap.id, arc.export_id, h.document_id, h.revision_id, arc.docx_sha256, JSON.stringify(final), JSON.stringify(responses), JSON.stringify(arc.versions), a.ownerId])).rows[0]!.id;
  });
  return (await getSubmission(pool, a.paperId, id))!;
}

export async function getSubmission(db: Queryable, paperId: string, id: string): Promise<Submission | null> {
  if (!UUID_RE.test(id)) return null;
  return (await db.query<Submission>(`SELECT ${SUBMISSION} FROM submissions WHERE paper_id = $1 AND id = $2`, [paperId, id])).rows[0] ?? null;
}
export async function listSubmissions(db: Queryable, paperId: string): Promise<Submission[]> {
  return (await db.query<Submission>(`SELECT ${SUBMISSION} FROM submissions WHERE paper_id = $1 ORDER BY created_at DESC, id LIMIT 100`, [paperId])).rows;
}

// the response table of a frozen submission (for the response letter), as Markdown
type Frozen = { position: number; round: string; reviewer: string; comment: string; status: string | null; response: string | null; links: { heading: string | null; change: string; holds: boolean }[] };
const STATUS_KO: Record<string, string> = { addressed: '수정함', partly_addressed: '일부 수정함', disagree: '동의하지 않음', explained: '설명함', not_addressed: '반영하지 않음' };
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
export function responseTable(s: Submission): string {
  const rows = (s.responses as Frozen[]).map((r) => {
    const where = r.links.map((l) => `${l.heading ?? '(제목 없음)'} (${l.change}${l.holds ? '' : ', 지금 원고에 없음'})`).join('; ');
    return `| ${r.position} | ${cell(`${r.round} ${r.reviewer}`)} | ${cell(r.comment)} | ${r.status ? STATUS_KO[r.status] ?? r.status : '답 없음'} | ${cell(r.response ?? '')} | ${cell(where)} |`;
  });
  return [
    `# ${cell(s.label)}`, '',
    `- 상태: ${s.status === 'submission_ready' ? '제출용 확정' : '초안'}${s.target ? ` · 대상: ${cell(s.target)}` : ''}`,
    `- 원고 버전: ${s.revision_id} · DOCX SHA-256: ${s.docx_sha256}`, '',
    '| # | 리뷰어 | 의견 | 답 | 답변 | 수정한 곳 |', '|---|---|---|---|---|---|', ...rows, '',
  ].join('\n');
}
