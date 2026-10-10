// The manuscript's structure follows the paper's own approved outline (PW-046, spec 06 "섹션 역할":
// Resource/Software/Methods papers get a structure that fits them, never a forced IMRaD).
// - Section templates are suggestions per article type, shown while the user writes the outline; no
//   section is required and any section name is accepted.
// - "Scaffold" is the user's act: the approved outline's sections, in outline order, become level-1
//   headings of the manuscript. Only headings that are missing are added (a heading of the same name,
//   any level, case and spacing aside, counts); the user's text is never changed or moved. It needs the
//   active approved outline and the head the user is looking at (a moved head is a conflict).
// - sectionEnd(): where a new paragraph of a section goes by default — after the last block of that
//   section (before the next heading of the same or a higher level).
import { randomUUID } from 'node:crypto';
import { schema, type parseDocument } from '@pw/editor-core';
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';
import { appendRevisionIn, lockDocumentHead } from '../revisions/index.ts';
import { ARTICLE_TYPES, type ArticleType } from '../papers/index.ts';
import { documentAt } from '../writer/index.ts';

type PMNode = ReturnType<typeof parseDocument>;
export interface SectionSuggestion { section: string; role: string }
// suggestions only (enforced: false): the user's outline decides the sections
export const SECTION_TEMPLATES: Record<ArticleType, SectionSuggestion[]> = {
  research_article: [
    { section: 'Introduction', role: 'the question, what is known, the gap this work fills' },
    { section: 'Results', role: 'what was observed, in the order of the story' },
    { section: 'Discussion', role: 'what the results mean, limits, other explanations' },
    { section: 'Methods', role: 'how it was done, enough to repeat it' },
  ],
  software_resource: [
    { section: 'Introduction', role: 'the need and what the tool or resource offers' },
    { section: 'Implementation', role: 'design, components and how they fit together' },
    { section: 'Usage', role: 'how a user runs it, with a worked example' },
    { section: 'Validation', role: 'how it was tested or benchmarked and against what' },
    { section: 'Availability', role: 'where the code or data is, licence, versions, requirements' },
  ],
  methods: [
    { section: 'Introduction', role: 'the problem the method solves and current approaches' },
    { section: 'Method', role: 'the procedure and its rationale' },
    { section: 'Validation', role: 'how the method was tested and its limits' },
    { section: 'Protocol', role: 'step by step, as a reader would run it' },
  ],
  review: [
    { section: 'Introduction', role: 'scope and why the topic needs a review now' },
    { section: 'Perspectives', role: 'open questions and where the field should go' },
  ],
  short_communication: [],
  other: [],
};

export function sectionTemplate(articleType: string) {
  const type = (ARTICLE_TYPES as readonly string[]).includes(articleType) ? (articleType as ArticleType) : 'other';
  return { article_type: type, enforced: false as const, sections: SECTION_TEMPLATES[type] };
}

export const sectionKey = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const textOf = (n: PMNode) => n.textContent;

// the block after which a new paragraph of `section` goes, or null when the manuscript has no such heading
export function sectionEnd(doc: PMNode, section: string): PMNode | null {
  const key = sectionKey(section);
  if (!key) return null;
  const blocks: PMNode[] = [];
  doc.forEach((n) => blocks.push(n));
  const at = blocks.findIndex((n) => n.type.name === 'heading' && sectionKey(textOf(n)) === key);
  if (at < 0) return null;
  const level = blocks[at]!.attrs.level as number;
  let end = at;
  for (let i = at + 1; i < blocks.length; i++) {
    const n = blocks[i]!;
    if (n.type.name === 'heading' && (n.attrs.level as number) <= level) break;
    end = i;
  }
  return blocks[end]!;
}

export async function scaffoldFromOutline(pool: TxPool, a: { paperId: string; ownerId: string; documentId: string; body: unknown }) {
  const b = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  if (typeof b.outline_revision_id !== 'string' || !UUID_RE.test(b.outline_revision_id)) throw new DomainError('INVALID', 'outline_revision_id must name the approved outline', 'outline_revision_id');
  const outlineId = b.outline_revision_id.toLowerCase();
  return inTransaction(pool, async (tx) => {
    // the outline stays the active approved one while this runs
    const p = (await tx.query<{ active: string | null }>(
      `SELECT CASE WHEN o.status = 'APPROVED' THEN p.active_outline_revision_id END AS active
       FROM paper_projects p LEFT JOIN outline_revisions o ON o.id = p.active_outline_revision_id WHERE p.id = $1 FOR SHARE OF p`, [a.paperId],
    )).rows[0];
    if (!p) throw new DomainError('NOT_FOUND', 'paper not found');
    if (p.active !== outlineId) throw new DomainError('CONFLICT', 'only the active approved outline can shape the manuscript', 'outline_revision_id', { details: { reason: 'outline_not_active' } });
    const head = await lockDocumentHead(tx, a.paperId, a.documentId, b.expected_head_revision_id);
    const kind = (await tx.query<{ kind: string }>('SELECT kind FROM documents WHERE id = $1', [a.documentId])).rows[0]!.kind;
    if (kind !== 'manuscript') throw new DomainError('INVALID', 'only a manuscript is built from the outline', 'document_id');
    const doc = (await documentAt(tx, a.paperId, a.documentId, head))!;
    const sections = await outlineSections(tx, outlineId);
    const present = new Set<string>();
    doc.forEach((n) => { if (n.type.name === 'heading') present.add(sectionKey(textOf(n))); });
    const missing = sections.filter((s) => !present.has(sectionKey(s)));
    if (!missing.length) return { added: [] as string[], revision_id: null, head_revision_id: head };
    const blocks: unknown[] = [];
    doc.forEach((n) => blocks.push(n.toJSON()));
    // a missing section goes after the section that precedes it in the outline (when that one exists),
    // otherwise at the end; nothing the user wrote moves
    for (const s of missing) {
      const idx = sections.indexOf(s);
      const heading = { type: 'heading', attrs: { id: randomUUID(), level: 1 }, content: [{ type: 'text', text: s }] };
      const prev = sections.slice(0, idx).reverse().find((x) => present.has(sectionKey(x)));
      let at = blocks.length;
      if (prev !== undefined) {
        // after the end of `prev`'s section (its next heading of the same or a higher level)
        const end = sectionEnd(schema.nodeFromJSON({ type: 'doc', content: blocks }), prev);
        if (end) at = blocks.findIndex((x) => (x as { attrs: { id: string } }).attrs.id === end.attrs.id) + 1;
      }
      blocks.splice(at, 0, heading);
      present.add(sectionKey(s));
    }
    const rev = await appendRevisionIn(tx, { paperId: a.paperId, documentId: a.documentId, parent: head, content: { type: 'doc', content: blocks }, schemaVersion: 1, ownerId: a.ownerId, reason: 'manual' });
    return { added: missing, revision_id: rev.id, head_revision_id: rev.id };
  });
}

// the outline's distinct sections in outline order (first appearance)
export async function outlineSections(db: Queryable, outlineId: string): Promise<string[]> {
  const { rows } = await db.query<{ section: string }>('SELECT section FROM outline_nodes WHERE outline_revision_id = $1 ORDER BY position, node_id', [outlineId]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const s = r.section.replace(/\s+/g, ' ').trim();
    if (!s || seen.has(sectionKey(s))) continue;
    seen.add(sectionKey(s));
    out.push(s);
  }
  return out;
}

export async function nodeSection(db: Queryable, outlineId: string, nodeId: string): Promise<string> {
  return (await db.query<{ section: string }>('SELECT section FROM outline_nodes WHERE outline_revision_id = $1 AND node_id = $2', [outlineId, nodeId])).rows[0]?.section ?? '';
}
