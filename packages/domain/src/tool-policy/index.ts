// Typed tool gateway (PW-027, spec 07 "Tool gateway", 09 비신뢰 데이터).
// A provider run calls paper tools only through this gateway, with a run token issued by the server.
// - The scope (owner, paper, document, editable selection handles) and the tool list come from the
//   token alone. Arguments never carry a paper, owner, document or approval: every tool's schema is
//   closed (additionalProperties: false), so a model that adds paper_id or approved_by is refused.
// - Read tools return this paper's approved outline, scoped paragraphs, user-verified facts,
//   reference metadata and figure numbers. The one write tool creates a proposal; applying it,
//   approving anything, verifying facts or changing budgets is not a tool at all (FORBIDDEN_TOOLS).
// - Every call is audited with its outcome and an argument hash (not the arguments).
// Tools of later tasks (literature search, outline/profile proposals, candidate references, review
// findings) are known names that answer not_available_yet until their task implements them.
import { createHash, randomBytes } from 'node:crypto';
import { figureLabels } from '@pw/editor-core';
import { DomainError, UUID_RE, type Queryable, type TxPool } from '../shared/db.ts';
import { getPaper } from '../papers/index.ts';
import { getOutlineRevision } from '../outlines/index.ts';
import { listFacts } from '../evidence/index.ts';
import { listFigures, listReferences } from '../references/index.ts';
import { approvedOutline, createProposal, getSelectionHandle, selectionSlice, PROPOSAL_INTENTS } from '../proposals/index.ts';
import { publish, validate, type Schema } from './schema.ts';
export { validate as validateToolArgs } from './schema.ts';

export const FORBIDDEN_TOOLS = [
  'approve_outline', 'approve_story', 'set_verified_fact', 'verify_evidence', 'apply_approved_patch', 'apply_proposal', 'change_owner',
  'delete_snapshot', 'change_budget', 'submit_paper', 'arbitrary_http', 'shell', 'write_file', 'read_file',
] as const;
export const LATER_TOOLS = ['search_literature_with_budget', 'propose_outline_change', 'propose_profile_change', 'add_candidate_reference', 'add_review_finding'] as const;
const PROVIDERS = ['claude_agent', 'codex', 'mock'] as const;
export type GatewayProvider = (typeof PROVIDERS)[number];

const uuid: Schema = { type: 'string', minLength: 36, maxLength: 36, pattern: UUID_RE.source };
interface Scope { tokenId: string; ownerId: string; paperId: string; documentId: string | null; handleIds: string[]; provider: GatewayProvider }
interface Tool { description: string; input: Schema; run: (pool: TxPool, s: Scope, args: Record<string, unknown>) => Promise<unknown> }
class NotInScope extends Error {}

// plain text of a block from stored document JSON: inline atoms appear as [citation] / [figure]
function blockText(node: { content?: unknown[] }): string {
  let out = '';
  for (const c of (node.content ?? []) as { type?: string; text?: string; content?: unknown[] }[]) {
    if (c.type === 'text') out += c.text ?? '';
    else if (c.type === 'citation') out += '[citation]';
    else if (c.type === 'figure_ref') out += '[figure]';
    else if (c.type === 'hard_break') out += '\n';
    else if (c.content) out += blockText(c);
  }
  return out;
}
const MAX_TEXT = 20_000;

const TOOLS: Record<string, Tool> = {
  get_approved_outline: {
    description: 'The approved outline of this paper (sections, paragraph goals, allowed interpretation, exclusions, word budgets). approved=false when no outline is approved.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(pool, s) {
      const id = await approvedOutline(pool, s.paperId);
      if (!id) return { approved: false };
      const o = (await getOutlineRevision(pool, s.paperId, id))!;
      return {
        approved: true, outline_revision_id: id,
        nodes: o.nodes.map((n) => ({
          node_id: n.node_id, parent_node_id: n.parent_node_id, position: n.position, section: n.section, role: n.role, paragraph_goal: n.paragraph_goal,
          claim_ids: n.claim_ids, evidence_ids: n.evidence_ids, requires_evidence: n.requires_evidence, allowed_interpretation: n.allowed_interpretation,
          exclusions: n.exclusions, transition: n.transition, word_budget_min: n.word_budget_min, word_budget_max: n.word_budget_max, status: n.status,
        })),
      };
    },
  },
  get_document_slice: {
    description: 'Text of the selection this run works on (handle_id) or of one paragraph of the run\'s document (block_id).',
    input: { type: 'object', properties: { handle_id: uuid, block_id: uuid }, additionalProperties: false },
    async run(pool, s, a) {
      if ((a.handle_id === undefined) === (a.block_id === undefined)) throw new DomainError('INVALID', 'give exactly one of handle_id and block_id');
      if (typeof a.handle_id === 'string') {
        const id = a.handle_id.toLowerCase();
        if (!s.handleIds.includes(id)) throw new NotInScope();
        const h = await getSelectionHandle(pool, s.paperId, id);
        if (!h || h.document_id !== s.documentId) throw new NotInScope();
        const { items } = await selectionSlice(pool, s.paperId, id);
        return { handle_id: id, block_id: h.block_id, base_revision_id: h.base_revision_id, text: items.map((i) => (i.type === 'text' ? i.text : `[atom ${i.atom_index}]`)).join('').slice(0, MAX_TEXT), items };
      }
      if (!s.documentId) throw new NotInScope();
      const head = (await pool.query<{ id: string; content_json: { content?: { type: string; attrs?: { id?: string; level?: number } }[] } }>(
        'SELECT r.id, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1 AND d.id = $2', [s.paperId, s.documentId])).rows[0];
      const block = head?.content_json.content?.find((b) => b.attrs?.id === String(a.block_id).toLowerCase());
      if (!block) throw new NotInScope();
      return { block_id: block.attrs!.id, revision_id: head!.id, type: block.type, ...(block.attrs?.level ? { level: block.attrs.level } : {}), text: blockText(block as { content?: unknown[] }).slice(0, MAX_TEXT) };
    },
  },
  get_fact_records: {
    description: 'Facts the user verified (value, unit, groups, comparison, n, statistics). Candidate or rejected values are never returned.',
    input: { type: 'object', properties: { fact_ids: { type: 'array', items: uuid, maxItems: 50, uniqueItems: true } }, additionalProperties: false },
    async run(pool, s, a) {
      const want = Array.isArray(a.fact_ids) ? new Set((a.fact_ids as string[]).map((x) => x.toLowerCase())) : null;
      const facts = (await listFacts(pool, s.paperId)).filter((f) => f.verification_state === 'VERIFIED' && !f.closed_at && (!want || want.has(f.id)));
      return {
        facts: facts.slice(0, 200).map((f) => ({ id: f.id, evidence_id: f.evidence_id, entity: f.entity, metric: f.metric, value_text: f.value_text, unit: f.unit, group: f.group, comparison: f.comparison, n: f.n, statistics: f.statistics })),
      };
    },
  },
  get_reference_excerpt: {
    description: 'Stored metadata of this paper\'s references (authors, year, title, journal, DOI). Excerpts arrive with the literature tasks; excerpt is null until then.',
    input: { type: 'object', properties: { reference_ids: { type: 'array', items: uuid, minItems: 1, maxItems: 20, uniqueItems: true } }, required: ['reference_ids'], additionalProperties: false },
    async run(pool, s, a) {
      const want = new Set((a.reference_ids as string[]).map((x) => x.toLowerCase()));
      return { references: (await listReferences(pool, s.paperId)).filter((r) => want.has(r.id)).map((r) => ({ id: r.id, authors: r.authors, year: r.year, title: r.title, container: r.container, doi: r.doi, excerpt: null })) };
    },
  },
  get_figure_metadata: {
    description: 'Figures and tables of this paper with their current numbers and titles.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(pool, s) {
      const figs = await listFigures(pool, s.paperId);
      const { numbers } = figureLabels([], figs);
      return { figures: figs.map((f) => ({ id: f.id, kind: f.kind, number: numbers.get(f.id) ?? null, title: f.title })) };
    },
  },
  propose_manuscript_edit: {
    description: 'Propose a replacement for the selection this run works on. It creates a proposal the user reviews; nothing changes in the manuscript until the user applies it.',
    input: {
      type: 'object',
      properties: {
        handle_id: uuid,
        intent: { type: 'string', maxLength: 20, enum: [...PROPOSAL_INTENTS] },
        replacement: { type: 'array', items: { type: 'opaque_object', maxKeys: 4 }, minItems: 1, maxItems: 200 },
        explanation: { type: 'string', maxLength: 4000 },
      },
      required: ['handle_id', 'intent', 'replacement'],
      additionalProperties: false,
    },
    async run(pool, s, a) {
      const id = String(a.handle_id).toLowerCase();
      if (!s.handleIds.includes(id)) throw new NotInScope();
      const h = await getSelectionHandle(pool, s.paperId, id);
      if (!h || h.document_id !== s.documentId) throw new NotInScope();
      const p = await createProposal(pool, { paperId: s.paperId, handleId: id, intent: a.intent, replacement: a.replacement, explanation: a.explanation, origin: `worker:tool-gateway:${s.provider}` });
      return { proposal_id: p.id, status: p.status, status_reason: p.status_reason, checks: p.checks };
    },
  },
};
export const TOOL_NAMES = Object.keys(TOOLS) as readonly string[];
const KNOWN = new Map(Object.entries(TOOLS));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_TTL_MS = 24 * 3600e3;
const MAX_ARGS_BYTES = 64 * 1024;

export async function issueRunToken(pool: TxPool, a: {
  ownerId: string; paperId: string; documentId: string | null; handleIds: string[]; provider: GatewayProvider; tools: readonly string[]; ttlMs: number; jobId?: string | null;
}): Promise<{ id: string; token: string; expires_at: string }> {
  if (!PROVIDERS.includes(a.provider)) throw new DomainError('INVALID', 'unknown provider');
  if (!Number.isInteger(a.ttlMs) || a.ttlMs < 1 || a.ttlMs > MAX_TTL_MS) throw new DomainError('INVALID', 'ttl must be between 1 ms and 24 h');
  if (!Array.isArray(a.tools) || !a.tools.length) throw new DomainError('INVALID', 'a run needs at least one tool');
  for (const t of a.tools) if (!KNOWN.has(t)) throw new DomainError('INVALID', `${String(t).slice(0, 60)} is not a gateway tool`);
  if (!(await getPaper(pool, a.ownerId, a.paperId))) throw new DomainError('NOT_FOUND', 'paper not found');
  if (a.documentId !== null && !(await pool.query('SELECT 1 FROM documents WHERE paper_id = $1 AND id = $2', [a.paperId, a.documentId])).rows[0]) throw new DomainError('NOT_FOUND', 'document not found');
  const handles = [...new Set(a.handleIds.map((h) => String(h).toLowerCase()))];
  for (const h of handles) {
    const row = UUID_RE.test(h) ? await getSelectionHandle(pool, a.paperId, h) : null;
    if (!row || row.document_id !== a.documentId) throw new DomainError('INVALID', 'a selection handle is not in this paper and document');
  }
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<{ id: string; expires_at: string }>(
    `INSERT INTO agent_run_tokens (token_hash, owner_id, paper_id, document_id, handle_ids, tools, provider, job_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp() + make_interval(secs => $9::double precision / 1000)) RETURNING id, expires_at`,
    [sha256(token), a.ownerId, a.paperId, a.documentId, handles, [...new Set(a.tools)], a.provider, a.jobId ?? null, a.ttlMs]);
  return { id: rows[0]!.id, token, expires_at: rows[0]!.expires_at };
}

export async function revokeRunToken(db: Queryable, tokenId: string): Promise<void> {
  await db.query('UPDATE agent_run_tokens SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL', [tokenId]);
}

async function scopeOf(db: Queryable, token: unknown): Promise<(Scope & { tools: string[] }) | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await db.query<{ id: string; owner_id: string; paper_id: string; document_id: string | null; handle_ids: string[]; tools: string[]; provider: GatewayProvider }>(
    `SELECT t.id, t.owner_id, t.paper_id, t.document_id, t.handle_ids, t.tools, t.provider FROM agent_run_tokens t
     JOIN paper_projects p ON p.id = t.paper_id AND p.owner_id = t.owner_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp()`, [sha256(token)]);
  const r = rows[0];
  return r ? { tokenId: r.id, ownerId: r.owner_id, paperId: r.paper_id, documentId: r.document_id, handleIds: r.handle_ids, tools: r.tools, provider: r.provider } : null;
}

export interface ToolDefinition { name: string; description: string; input_schema: Record<string, unknown> }
export async function toolDefinitions(db: Queryable, token: string): Promise<ToolDefinition[]> {
  const s = await scopeOf(db, token);
  if (!s) return [];
  return s.tools.filter((t) => KNOWN.has(t)).sort().map((name) => ({ name, description: TOOLS[name]!.description, input_schema: publish(TOOLS[name]!.input) }));
}

export type ToolErrorCode = 'invalid_token' | 'unknown_tool' | 'forbidden_tool' | 'not_available_yet' | 'tool_not_allowed' | 'invalid_arguments' | 'not_in_scope' | 'rejected' | 'internal';
export type ToolOutcome = { ok: true; result: unknown; error?: undefined } | { ok: false; error: { code: ToolErrorCode; message: string }; result?: undefined };

// control, zero-width and bidi characters become '?' so the audit shows what was really asked
const HIDDEN = (c: number) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff;
const printable = (s: string) => [...s].map((ch) => (HIDDEN(ch.codePointAt(0)!) ? '?' : ch)).join('').slice(0, 100) || '?';

export async function callTool(pool: TxPool, token: string, name: unknown, args: unknown): Promise<ToolOutcome> {
  const tool = typeof name === 'string' ? name : String(name);
  let argsText: string;
  try { argsText = JSON.stringify(args ?? null) ?? 'null'; } catch { argsText = 'unserializable'; }
  const s = await scopeOf(pool, token);
  const audit = async (outcome: 'ok' | 'refused' | 'error', reason: string | null) => {
    await pool.query('INSERT INTO agent_tool_calls (token_id, tool, outcome, reason, args_sha256) VALUES ($1, $2, $3, $4, $5)', [s?.tokenId ?? null, printable(tool), outcome, reason, sha256(argsText)]);
  };
  const refuse = async (code: ToolErrorCode, message: string): Promise<ToolOutcome> => { await audit('refused', code); return { ok: false, error: { code, message } }; };
  if (!s) return refuse('invalid_token', 'the run token is unknown, expired or revoked');
  if ((FORBIDDEN_TOOLS as readonly string[]).includes(tool)) return refuse('forbidden_tool', `${printable(tool)} is not a tool: approvals, applying, verification, budgets and system access stay with the user`);
  if ((LATER_TOOLS as readonly string[]).includes(tool)) return refuse('not_available_yet', `${tool} is not available yet`);
  const def = KNOWN.get(tool);
  if (!def) return refuse('unknown_tool', `${printable(tool)} is not a tool`);
  if (!s.tools.includes(tool)) return refuse('tool_not_allowed', `this run may not use ${tool}`);
  if (Buffer.byteLength(argsText) > MAX_ARGS_BYTES) return refuse('invalid_arguments', 'the arguments are too large');
  const bad = validate(def.input, args);
  if (bad) return refuse('invalid_arguments', bad);
  try {
    const result = await def.run(pool, s, args as Record<string, unknown>);
    await audit('ok', null);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof NotInScope) return refuse('not_in_scope', 'that object is not part of this run');
    if (e instanceof DomainError) {
      await audit('refused', 'rejected');
      return { ok: false, error: { code: 'rejected', message: e.message.slice(0, 500) } };
    }
    await audit('error', 'internal');
    return { ok: false, error: { code: 'internal', message: 'the tool failed' } };
  }
}

// every tool's published input schema (for the contract test and documentation)
export function publishedSchemas(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, publish(t.input)]));
}
export function toolInputSchema(name: string): Schema | null {
  return KNOWN.get(name)?.input ?? null;
}
