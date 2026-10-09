// Research brief + storyline revisions and detailed outline revisions (spec 03).
// Content never changes after it is written (DB guard); approval names an exact revision by its
// content hash and an explicit UI intent, and the approver always comes from the session.
// The paper's active story/outline move only through approval. The AI draft gate is checked here,
// on the server, against those active, approved revisions.
import { randomUUID } from 'node:crypto';
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../shared/db.ts';
import { contentHash } from '../revisions/index.ts';
import { unresolvedNodes } from '../outline-impact/index.ts';

// A DomainError that carries machine-readable details (missing fields, gate reasons …).
export class OutlineError extends DomainError {
  constructor(code: DomainError['code'], message: string, details: Record<string, unknown>, field?: string) {
    super(code, message, field, { details });
  }
}

type FieldKind = 'text' | 'list';
const BRIEF_FIELDS: Record<string, FieldKind> = { purpose: 'text', audience: 'text', known_facts: 'list', missing_material: 'list', avoid_claims: 'list' };
const STORY_FIELDS: Record<string, FieldKind> = {
  question: 'text', main_message: 'text', novelty: 'text', evidence_links: 'list', competing_explanations: 'list', presentation_order: 'list', limitations: 'list',
};
// fields that must be filled before a story can be approved
export const STORY_REQUIRED = ['brief.purpose', 'story.question', 'story.main_message'] as const;
export const NODE_ROLES = ['background', 'gap', 'aim', 'method', 'result', 'interpretation', 'comparison', 'limitation', 'conclusion', 'other'] as const;
export const DRAFT_GATE_REASONS = ['story_not_approved', 'outline_not_active', 'node_not_found', 'node_not_approved', 'evidence_missing', 'impact_review_required'] as const;
const FORBIDDEN_APPROVAL_KEYS = ['approved_by', 'approved_at', 'status'];
const MAX_NODES = 500;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const invalid = (message: string, field: string) => new DomainError('INVALID', message, field);

function text(v: unknown, field: string, max: number, { required = false } = {}): string {
  if (v === undefined || v === null) {
    if (required) throw invalid(`${field} is required`, field);
    return '';
  }
  if (typeof v !== 'string' || v.length > max || !storable(v)) throw invalid(`${field} must be text up to ${max} characters (no NUL or unpaired surrogate)`, field);
  if (required && !v.trim()) throw invalid(`${field} must not be empty`, field);
  return v;
}
function list(v: unknown, field: string, { maxItems = 100, maxLen = 2000, ids = false } = {}): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems || v.some((x) => typeof x !== 'string' || x.length > maxLen || !storable(x))) {
    throw invalid(`${field} must be a list of up to ${maxItems} strings`, field);
  }
  // a blank id would let an evidence-required paragraph pass with no evidence behind it
  if (ids && v.some((x) => !(x as string).trim())) throw invalid(`${field} must not contain blank ids`, field);
  return [...v] as string[];
}
function fields(v: unknown, prefix: string, spec: Record<string, FieldKind>): Record<string, string | string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(`${prefix} must be an object`, prefix);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in spec)) throw invalid(`${prefix}.${k} is not a known field`, `${prefix}.${k}`);
  const out: Record<string, string | string[]> = {};
  for (const [k, kind] of Object.entries(spec)) out[k] = kind === 'text' ? text(o[k], `${prefix}.${k}`, 4000) : list(o[k], `${prefix}.${k}`);
  return out;
}
function rejectUnknownKeys(body: Record<string, unknown>, allowed: string[]) {
  for (const k of FORBIDDEN_APPROVAL_KEYS) {
    if (k in body) throw invalid(`${k} is set by the server from your session; do not send it`, k);
  }
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid(`${k} is not accepted here`, k);
}
function approvalIntent(body: Record<string, unknown>, intent: string): string {
  if (body.intent !== intent) throw invalid(`intent must be "${intent}" (an explicit approval action)`, 'intent');
  if (typeof body.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.content_hash)) throw invalid('content_hash of the revision you reviewed is required', 'content_hash');
  return body.content_hash;
}

async function lockPaper(tx: Queryable, paperId: string) {
  const { rows } = await tx.query<{ active_story_revision_id: string | null; active_outline_revision_id: string | null }>(
    'SELECT active_story_revision_id, active_outline_revision_id FROM paper_projects WHERE id = $1 FOR UPDATE',
    [paperId],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'paper not found');
  return rows[0];
}

// ---------- story ----------

export interface StoryRevision {
  id: string;
  paper_id: string;
  parent_revision_id: string | null;
  brief: Record<string, string | string[]>;
  story: Record<string, string | string[]>;
  content_hash: string;
  status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'SUPERSEDED';
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  superseded_at: string | null;
}
const STORY_COLS = 'id, paper_id, parent_revision_id, brief, story, content_hash, status, created_by, created_at, approved_by, approved_at, superseded_at';

export function storyMissing(r: Pick<StoryRevision, 'brief' | 'story'>): string[] {
  return STORY_REQUIRED.filter((path) => {
    const [part, key] = path.split('.') as ['brief' | 'story', string];
    const v = r[part][key];
    return typeof v !== 'string' || !v.trim();
  });
}

async function latestId(tx: Queryable, table: 'story_revisions' | 'outline_revisions', paperId: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(`SELECT id FROM ${table} WHERE paper_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [paperId]);
  return rows[0]?.id ?? null;
}
function checkParent(parent: unknown): string | null {
  if (parent !== null && !isUuid(parent)) throw invalid('parent_revision_id must be the id of the latest revision, or null for the first one', 'parent_revision_id');
  return parent === null ? null : parent.toLowerCase();
}

export async function createStoryRevision(pool: TxPool, a: { paperId: string; ownerId: string; parent: unknown; brief: unknown; story: unknown }): Promise<StoryRevision> {
  return inTransaction(pool, (tx) => createStoryRevisionIn(tx, a));
}
// in the caller's transaction (PW-039: adopting a story alternative records the adoption with it)
export async function createStoryRevisionIn(tx: Queryable, a: { paperId: string; ownerId: string; parent: unknown; brief: unknown; story: unknown }): Promise<StoryRevision> {
  const parent = checkParent(a.parent);
  const brief = fields(a.brief, 'brief', BRIEF_FIELDS);
  const story = fields(a.story, 'story', STORY_FIELDS);
  await lockPaper(tx, a.paperId);
  if ((await latestId(tx, 'story_revisions', a.paperId)) !== parent) throw new DomainError('CONFLICT', 'the story changed since you loaded it (stale parent revision); reload before saving');
  const { rows } = await tx.query<StoryRevision>(
    `INSERT INTO story_revisions (id, paper_id, parent_revision_id, brief, story, content_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${STORY_COLS}`,
    [randomUUID(), a.paperId, parent, JSON.stringify(brief), JSON.stringify(story), contentHash({ brief, story }), a.ownerId],
  );
  return rows[0]!;
}

export async function approveStoryRevision(pool: TxPool, a: { paperId: string; ownerId: string; revisionId: string; body: unknown }): Promise<StoryRevision> {
  const body = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  rejectUnknownKeys(body, ['intent', 'content_hash']);
  const hash = approvalIntent(body, 'approve_story');
  if (!isUuid(a.revisionId)) throw new DomainError('NOT_FOUND', 'story revision not found');
  return inTransaction(pool, async (tx) => {
    const paper = await lockPaper(tx, a.paperId);
    const { rows } = await tx.query<StoryRevision & { older_than_active: boolean }>(
      `SELECT ${STORY_COLS}, (r.created_at < a.created_at) AS older_than_active
       FROM story_revisions r LEFT JOIN story_revisions a ON a.id = $3
       WHERE r.id = $1 AND r.paper_id = $2 FOR UPDATE OF r`.replace(STORY_COLS, STORY_COLS.split(', ').map((c) => `r.${c}`).join(', ')),
      [a.revisionId, a.paperId, paper.active_story_revision_id],
    );
    const rev = rows[0];
    if (!rev) throw new DomainError('NOT_FOUND', 'story revision not found');
    if (rev.content_hash !== hash) throw new DomainError('CONFLICT', 'this revision is not the content you reviewed (content hash differs); reload it');
    const { older_than_active: older, ...out } = rev;
    if (rev.status === 'APPROVED') return out;
    if (rev.status === 'SUPERSEDED') throw new DomainError('CONFLICT', 'this revision was superseded; save a new revision instead');
    if (older) throw new DomainError('CONFLICT', 'a newer story revision is already approved; save a new revision based on it');
    const missing = storyMissing(rev);
    if (missing.length) throw new OutlineError('INVALID', `required fields are empty: ${missing.join(', ')}`, { missing }, missing[0]);
    await tx.query("UPDATE story_revisions SET status = 'SUPERSEDED', superseded_at = clock_timestamp() WHERE paper_id = $1 AND status = 'APPROVED'", [a.paperId]);
    const done = await tx.query<StoryRevision>(
      `UPDATE story_revisions SET status = 'APPROVED', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1 RETURNING ${STORY_COLS}`,
      [rev.id, a.ownerId],
    );
    await tx.query('UPDATE paper_projects SET active_story_revision_id = $2, updated_at = now() WHERE id = $1', [a.paperId, rev.id]);
    return done.rows[0]!;
  });
}

export async function getStoryRevision(db: Queryable, paperId: string, revisionId: string): Promise<StoryRevision | null> {
  if (!isUuid(revisionId)) return null;
  const { rows } = await db.query<StoryRevision>(`SELECT ${STORY_COLS} FROM story_revisions WHERE id = $1 AND paper_id = $2`, [revisionId, paperId]);
  return rows[0] ?? null;
}

export async function getStory(db: Queryable, paperId: string) {
  const { rows } = await db.query<StoryRevision>(`SELECT ${STORY_COLS} FROM story_revisions WHERE paper_id = $1 ORDER BY created_at DESC, id DESC`, [paperId]);
  const active = rows.find((r) => r.status === 'APPROVED') ?? null;
  return { active, latest: rows[0] ?? null, missing: rows[0] ? storyMissing(rows[0]) : [...STORY_REQUIRED], revisions: rows };
}

// ---------- outline ----------

export interface OutlineNodeInput {
  node_id: string;
  parent_node_id: string | null;
  section: string;
  role: (typeof NODE_ROLES)[number];
  paragraph_goal: string;
  claim_ids: string[];
  evidence_ids: string[];
  requires_evidence: boolean;
  allowed_interpretation: string;
  exclusions: string[];
  transition: string;
  word_budget_min: number | null;
  word_budget_max: number | null;
}
const NODE_KEYS = ['node_id', 'parent_node_id', 'section', 'role', 'paragraph_goal', 'claim_ids', 'evidence_ids', 'requires_evidence', 'allowed_interpretation', 'exclusions', 'transition', 'word_budget_min', 'word_budget_max'];

export type NodeStatus = 'DRAFT' | 'APPROVED' | 'EVIDENCE_MISSING' | 'IMPACT_REVIEW_REQUIRED';
export interface OutlineNode extends OutlineNodeInput {
  position: number;
  status: NodeStatus;
  approved_by: string | null;
  approved_at: string | null;
}
export interface OutlineRevision {
  id: string;
  paper_id: string;
  story_revision_id: string;
  parent_revision_id: string | null;
  content_hash: string;
  status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'SUPERSEDED';
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  superseded_at: string | null;
}
const OUTLINE_COLS = 'id, paper_id, story_revision_id, parent_revision_id, content_hash, status, created_by, created_at, approved_by, approved_at, superseded_at';

function budget(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100_000) throw invalid(`${field} must be a whole number of words or null`, field);
  return v as number;
}

export function validateNodes(raw: unknown): OutlineNodeInput[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_NODES) throw invalid(`nodes must be a list of 1–${MAX_NODES} paragraph plans`, 'nodes');
  const nodes = raw.map((n, i): OutlineNodeInput => {
    const f = `nodes[${i}]`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw invalid(`${f} must be an object`, f);
    const o = n as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!NODE_KEYS.includes(k)) throw invalid(`${f}.${k} is not a known field`, `${f}.${k}`);
    if (!isUuid(o.node_id)) throw invalid(`${f}.node_id must be a UUID`, `${f}.node_id`);
    if (o.parent_node_id !== undefined && o.parent_node_id !== null && !isUuid(o.parent_node_id)) throw invalid(`${f}.parent_node_id must be a UUID or null`, `${f}.parent_node_id`);
    if (!NODE_ROLES.includes(o.role as (typeof NODE_ROLES)[number])) throw invalid(`${f}.role must be one of ${NODE_ROLES.join(', ')}`, `${f}.role`);
    if (o.requires_evidence !== undefined && typeof o.requires_evidence !== 'boolean') throw invalid(`${f}.requires_evidence must be true or false`, `${f}.requires_evidence`);
    const min = budget(o.word_budget_min, `${f}.word_budget_min`);
    const max = budget(o.word_budget_max, `${f}.word_budget_max`);
    if (min !== null && max !== null && max < min) throw invalid(`${f}.word_budget_max must not be below word_budget_min`, `${f}.word_budget_max`);
    return {
      node_id: (o.node_id as string).toLowerCase(),
      parent_node_id: o.parent_node_id ? (o.parent_node_id as string).toLowerCase() : null,
      section: text(o.section, `${f}.section`, 120, { required: true }),
      role: o.role as OutlineNodeInput['role'],
      paragraph_goal: text(o.paragraph_goal, `${f}.paragraph_goal`, 2000, { required: true }),
      claim_ids: list(o.claim_ids, `${f}.claim_ids`, { maxItems: 200, maxLen: 200, ids: true }),
      evidence_ids: list(o.evidence_ids, `${f}.evidence_ids`, { maxItems: 200, maxLen: 200, ids: true }),
      requires_evidence: (o.requires_evidence as boolean | undefined) ?? false,
      allowed_interpretation: text(o.allowed_interpretation, `${f}.allowed_interpretation`, 2000),
      exclusions: list(o.exclusions, `${f}.exclusions`),
      transition: text(o.transition, `${f}.transition`, 1000),
      word_budget_min: min,
      word_budget_max: max,
    };
  });
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  if (byId.size !== nodes.length) throw invalid('node_id values must be unique within an outline', 'nodes');
  for (const n of nodes) {
    if (n.parent_node_id === null) continue;
    if (!byId.has(n.parent_node_id)) throw invalid(`parent_node_id ${n.parent_node_id} is not a node of this outline`, 'nodes');
    const seen = new Set([n.node_id]);
    for (let p: string | null = n.parent_node_id; p; p = byId.get(p)!.parent_node_id) {
      if (seen.has(p)) throw invalid('outline nodes form a cycle', 'nodes');
      seen.add(p);
    }
  }
  return nodes;
}

// parents before children (the self-reference FK is checked per row)
function insertionOrder(nodes: OutlineNodeInput[]): { node: OutlineNodeInput; position: number }[] {
  const out: { node: OutlineNodeInput; position: number }[] = [];
  const placed = new Set<string>();
  const indexed = nodes.map((node, position) => ({ node, position }));
  while (out.length < nodes.length) {
    for (const x of indexed) {
      if (placed.has(x.node.node_id) || (x.node.parent_node_id && !placed.has(x.node.parent_node_id))) continue;
      placed.add(x.node.node_id);
      out.push(x);
    }
  }
  return out;
}

export async function createOutlineRevision(pool: TxPool, a: { paperId: string; ownerId: string; parent: unknown; storyRevisionId: unknown; nodes: unknown }) {
  const parent = checkParent(a.parent);
  if (!isUuid(a.storyRevisionId)) throw invalid('story_revision_id must name an approved story revision', 'story_revision_id');
  const storyRevisionId = a.storyRevisionId.toLowerCase();
  const nodes = validateNodes(a.nodes);
  return inTransaction(pool, async (tx) => {
    await lockPaper(tx, a.paperId);
    const story = await tx.query<{ status: string }>('SELECT status FROM story_revisions WHERE id = $1 AND paper_id = $2', [storyRevisionId, a.paperId]);
    if (!story.rows[0]) throw new DomainError('NOT_FOUND', 'story revision not found in this paper');
    if (story.rows[0].status !== 'APPROVED') throw invalid('an outline is built on the approved (active) story; approve the story first', 'story_revision_id');
    if ((await latestId(tx, 'outline_revisions', a.paperId)) !== parent) throw new DomainError('CONFLICT', 'the outline changed since you loaded it (stale parent revision); reload before saving');
    const id = randomUUID();
    await tx.query(
      'INSERT INTO outline_revisions (id, paper_id, story_revision_id, parent_revision_id, content_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, a.paperId, storyRevisionId, parent, contentHash({ story_revision_id: storyRevisionId, nodes }), a.ownerId],
    );
    for (const { node: n, position } of insertionOrder(nodes)) {
      await tx.query(
        `INSERT INTO outline_nodes (outline_revision_id, paper_id, node_id, parent_node_id, position, section, role, paragraph_goal, claim_ids, evidence_ids,
           requires_evidence, allowed_interpretation, exclusions, transition, word_budget_min, word_budget_max)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [id, a.paperId, n.node_id, n.parent_node_id, position, n.section, n.role, n.paragraph_goal, n.claim_ids, n.evidence_ids,
          n.requires_evidence, n.allowed_interpretation, n.exclusions, n.transition, n.word_budget_min, n.word_budget_max],
      );
    }
    return (await readOutline(tx, a.paperId, id))!;
  });
}

async function readOutline(db: Queryable, paperId: string, revisionId: string): Promise<(OutlineRevision & { nodes: OutlineNode[] }) | null> {
  if (!isUuid(revisionId)) return null;
  const { rows } = await db.query<OutlineRevision & { active_story_revision_id: string | null }>(
    `SELECT ${OUTLINE_COLS.split(', ').map((c) => `o.${c}`).join(', ')}, p.active_story_revision_id
     FROM outline_revisions o JOIN paper_projects p ON p.id = o.paper_id WHERE o.id = $1 AND o.paper_id = $2`,
    [revisionId, paperId],
  );
  if (!rows[0]) return null;
  const { active_story_revision_id: activeStory, ...rev } = rows[0];
  const impact = rev.status !== 'SUPERSEDED' && rev.story_revision_id !== activeStory;
  const nodes = await db.query<Omit<OutlineNode, 'status'>>(
    `SELECT n.node_id, n.parent_node_id, n.position, n.section, n.role, n.paragraph_goal, n.claim_ids, n.evidence_ids, n.requires_evidence,
            n.allowed_interpretation, n.exclusions, n.transition, n.word_budget_min, n.word_budget_max, a.approved_by, a.approved_at
     FROM outline_nodes n LEFT JOIN outline_node_approvals a ON a.outline_revision_id = n.outline_revision_id AND a.node_id = n.node_id
     WHERE n.outline_revision_id = $1 AND n.paper_id = $2 ORDER BY n.position`,
    [revisionId, paperId],
  );
  // a node whose sources changed since (claim/evidence withdrawn, figure redrawn …; PW-040)
  const impacted = rev.status === 'SUPERSEDED' ? new Set<string>() : await unresolvedNodes(db, paperId, revisionId);
  return {
    ...rev,
    impact_review_required: impact,
    nodes: nodes.rows.map((n) => ({
      ...n,
      status: impact || impacted.has(n.node_id) ? 'IMPACT_REVIEW_REQUIRED' : n.approved_at ? 'APPROVED' : n.requires_evidence && n.evidence_ids.length === 0 ? 'EVIDENCE_MISSING' : 'DRAFT',
    })),
  } as OutlineRevision & { nodes: OutlineNode[] };
}
export const getOutlineRevision = readOutline;

export async function getOutline(db: Queryable, paperId: string) {
  const { rows } = await db.query<OutlineRevision>(`SELECT ${OUTLINE_COLS} FROM outline_revisions WHERE paper_id = $1 ORDER BY created_at DESC, id DESC`, [paperId]);
  const activeMeta = rows.find((r) => r.status === 'APPROVED');
  return { active: activeMeta ? await readOutline(db, paperId, activeMeta.id) : null, latest: rows[0] ?? null, revisions: rows };
}

export async function approveOutlineRevision(pool: TxPool, a: { paperId: string; ownerId: string; revisionId: string; body: unknown }) {
  const body = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  rejectUnknownKeys(body, ['intent', 'content_hash', 'node_ids']);
  const hash = approvalIntent(body, 'approve_outline');
  let nodeIds: string[] | null = null;
  if (body.node_ids !== undefined && body.node_ids !== null) {
    if (!Array.isArray(body.node_ids) || !body.node_ids.length || body.node_ids.length > MAX_NODES || !body.node_ids.every(isUuid)) {
      throw invalid('node_ids must be a non-empty list of node ids, or omitted to approve every node', 'node_ids');
    }
    nodeIds = [...new Set((body.node_ids as string[]).map((x) => x.toLowerCase()))];
  }
  if (!isUuid(a.revisionId)) throw new DomainError('NOT_FOUND', 'outline revision not found');
  return inTransaction(pool, async (tx) => {
    const paper = await lockPaper(tx, a.paperId);
    const { rows } = await tx.query<OutlineRevision & { older_than_active: boolean }>(
      `SELECT ${OUTLINE_COLS.split(', ').map((c) => `o.${c}`).join(', ')}, (o.created_at < act.created_at) AS older_than_active
       FROM outline_revisions o LEFT JOIN outline_revisions act ON act.id = $3
       WHERE o.id = $1 AND o.paper_id = $2 FOR UPDATE OF o`,
      [a.revisionId, a.paperId, paper.active_outline_revision_id],
    );
    const rev = rows[0];
    if (!rev) throw new DomainError('NOT_FOUND', 'outline revision not found');
    if (rev.content_hash !== hash) throw new DomainError('CONFLICT', 'this revision is not the outline you reviewed (content hash differs); reload it');
    if (rev.status === 'SUPERSEDED') throw new DomainError('CONFLICT', 'this outline revision was superseded; save a new revision instead');
    if (rev.older_than_active) throw new DomainError('CONFLICT', 'a newer outline revision is already active; save a new revision based on it');
    if (rev.story_revision_id !== paper.active_story_revision_id) {
      throw new OutlineError('CONFLICT', 'the story this outline was built on is no longer the approved story; review the impact and save the outline on the new story', { reasons: ['impact_review_required'] });
    }
    const nodes = (await tx.query<{ node_id: string; requires_evidence: boolean; evidence_ids: string[] }>(
      'SELECT node_id, requires_evidence, evidence_ids FROM outline_nodes WHERE outline_revision_id = $1 ORDER BY position', [rev.id],
    )).rows;
    const known = new Set(nodes.map((n) => n.node_id));
    const unknown = (nodeIds ?? []).filter((id) => !known.has(id));
    if (unknown.length) throw new OutlineError('INVALID', 'some node_ids are not part of this outline revision', { unknown_node_ids: unknown }, 'node_ids');
    const target = nodeIds ? nodes.filter((n) => nodeIds.includes(n.node_id)) : nodes;
    const evidenceMissing = target.filter((n) => n.requires_evidence && n.evidence_ids.length === 0).map((n) => n.node_id);
    if (evidenceMissing.length) throw new OutlineError('INVALID', 'these paragraph plans need evidence before they can be approved', { evidence_missing: evidenceMissing }, 'node_ids');
    for (const n of target) {
      await tx.query(
        'INSERT INTO outline_node_approvals (outline_revision_id, paper_id, node_id, content_hash, approved_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [rev.id, a.paperId, n.node_id, rev.content_hash, a.ownerId],
      );
    }
    const approved = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM outline_node_approvals WHERE outline_revision_id = $1', [rev.id])).rows[0]!.n;
    if (approved === nodes.length && rev.status !== 'APPROVED') {
      await tx.query("UPDATE outline_revisions SET status = 'SUPERSEDED', superseded_at = clock_timestamp() WHERE paper_id = $1 AND status = 'APPROVED'", [a.paperId]);
      await tx.query("UPDATE outline_revisions SET status = 'APPROVED', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1", [rev.id, a.ownerId]);
      await tx.query('UPDATE paper_projects SET active_outline_revision_id = $2, updated_at = now() WHERE id = $1', [a.paperId, rev.id]);
    } else if (rev.status === 'DRAFT') {
      await tx.query("UPDATE outline_revisions SET status = 'IN_REVIEW' WHERE id = $1", [rev.id]);
    }
    return (await readOutline(tx, a.paperId, rev.id))!;
  });
}

// ---------- AI draft gate ----------

// Server-side check before any AI draft for a paragraph is accepted (spec 03 "AI generation 요청 시").
// Manual saves never go through this gate.
// One transaction holding the paper row (FOR SHARE), so an approval cannot commit between the reads;
// PW-013 reruns this inside the enqueue transaction and stores what it pinned.
export async function checkDraftGate(pool: TxPool, paperId: string, body: unknown) {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  text(b.instruction, 'instruction', 4000, { required: true });
  if (typeof b.node_id !== 'string') throw invalid('node_id is required', 'node_id');
  const outlineId = b.outline_revision_id ?? null;
  if (outlineId !== null && typeof outlineId !== 'string') throw invalid('outline_revision_id must be a string or null', 'outline_revision_id');
  return inTransaction(pool, (db) => gateIn(db, paperId, b, outlineId));
}

async function gateIn(db: Queryable, paperId: string, b: Record<string, unknown>, outlineId: string | null) {
  // lock first, in its own statement: a gate that waited behind an approval then reads the committed state
  // (a single SELECT … FOR SHARE re-reads only the locked row, not the joined revisions)
  await db.query('SELECT 1 FROM paper_projects WHERE id = $1 FOR SHARE', [paperId]);
  // pointers count only while the revisions they name are APPROVED (the DB also enforces this at commit)
  const { rows: pr } = await db.query<{ active_story_revision_id: string | null; active_outline_revision_id: string | null }>(
    `SELECT CASE WHEN s.status = 'APPROVED' THEN p.active_story_revision_id END AS active_story_revision_id,
            CASE WHEN o.status = 'APPROVED' THEN p.active_outline_revision_id END AS active_outline_revision_id
     FROM paper_projects p
     LEFT JOIN story_revisions s ON s.id = p.active_story_revision_id
     LEFT JOIN outline_revisions o ON o.id = p.active_outline_revision_id
     WHERE p.id = $1`, [paperId],
  );
  const paper = pr[0];
  if (!paper) throw new DomainError('NOT_FOUND', 'paper not found');
  const reasons = new Set<(typeof DRAFT_GATE_REASONS)[number]>();
  if (!paper.active_story_revision_id) reasons.add('story_not_approved');
  const outline = isUuid(outlineId)
    ? (await db.query<{ id: string; story_revision_id: string }>('SELECT id, story_revision_id FROM outline_revisions WHERE id = $1 AND paper_id = $2', [outlineId, paperId])).rows[0]
    : undefined;
  if (!outline || outline.id !== paper.active_outline_revision_id) reasons.add('outline_not_active');
  if (outline) {
    if (paper.active_story_revision_id && outline.story_revision_id !== paper.active_story_revision_id) reasons.add('impact_review_required');
    const node = isUuid(b.node_id)
      ? (await db.query<{ approved: boolean; requires_evidence: boolean; evidence_ids: string[] }>(
        `SELECT (a.node_id IS NOT NULL) AS approved, n.requires_evidence, n.evidence_ids FROM outline_nodes n
         LEFT JOIN outline_node_approvals a ON a.outline_revision_id = n.outline_revision_id AND a.node_id = n.node_id
         WHERE n.outline_revision_id = $1 AND n.node_id = $2`, [outline.id, b.node_id.toLowerCase()],
      )).rows[0]
      : undefined;
    if (!node) reasons.add('node_not_found');
    else {
      if (!node.approved) reasons.add('node_not_approved');
      if (node.requires_evidence && node.evidence_ids.length === 0) reasons.add('evidence_missing');
      // a source of this node changed and the owner has not reviewed it (PW-040); other nodes go on
      if ((await unresolvedNodes(db, paperId, outline.id)).has((b.node_id as string).toLowerCase())) reasons.add('impact_review_required');
    }
  }
  if (reasons.size) {
    throw new OutlineError('CONFLICT', 'AI drafting is blocked until the story and this paragraph plan are approved', { reasons: DRAFT_GATE_REASONS.filter((r) => reasons.has(r)) });
  }
  return { gate: 'passed' as const, paper_id: paperId, story_revision_id: paper.active_story_revision_id, outline_revision_id: outline!.id, node_id: (b.node_id as string).toLowerCase() };
}
