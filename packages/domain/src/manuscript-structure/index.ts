// The manuscript's structure follows the paper's own approved outline (PW-046, spec 06 "섹션 역할":
// Resource/Software/Methods papers get a structure that fits them, never a forced IMRaD).
// - Section templates are suggestions per article type, shown while the user writes the outline; no
//   section is required and any section name is accepted.
// - "Scaffold" is the user's act: the approved outline's sections, in outline order, become the
//   headings of the manuscript. Only sections that are missing are added; the user's text is never
//   changed or moved. It needs the active approved outline and the head the user is looking at (a
//   moved head is a conflict).
// - Sections are the manuscript's top-level headings (its highest heading level); names compare without
//   case, spacing or a leading number. A missing section goes after its outline predecessor's section,
//   else before its outline successor, else at the end; new headings take the section level.
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

// a section's name for comparison: Unicode-normalised, spacing collapsed, case ignored, without a
// leading section number ("2.", "2.1", "IV.") or trailing punctuation (review MINOR 2: imported
// manuscripts number their headings)
// (re-review NIT 2: a bare number is a section number only up to two digits — "1000 Genomes data" keeps it)
export const sectionKey = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim()
  .replace(/^(?:\d{1,2}(?:\.\d+)*[.)]?|[IVX]+[.)])\s+/i, '').replace(/[\s.:;]+$/, '').toLowerCase();
const textOf = (n: PMNode) => n.textContent;
const blocksOf = (doc: PMNode) => { const out: PMNode[] = []; doc.forEach((n) => out.push(n)); return out; };
// names that are sections, not a paper's title
const KNOWN_SECTIONS = new Set([
  ...Object.values(SECTION_TEMPLATES).flat().map((x) => x.section),
  'Abstract', 'Summary', 'Background', 'Materials and Methods', 'Methods', 'Results and Discussion', 'Conclusion', 'Conclusions',
  'Limitations', 'Acknowledgements', 'Acknowledgments', 'References', 'Supplementary Information', 'Data Availability', 'Code Availability',
].map(sectionKey));
// the manuscript's section level: its highest heading level (1 when it has none). Only headings of this
// level are sections; a same-name subsection is not (review MINOR 1). A lone first heading above
// lower-level headings is the paper's title ("# Title / ## Introduction …", as Markdown imports are),
// unless it is named as a section — known, or one of `sectionNames` (the outline's) (re-review R1).
export const sectionLevel = (doc: PMNode, sectionNames: string[] = []) => {
  const blocks = blocksOf(doc);
  const levels = blocks.filter((n) => n.type.name === 'heading').map((n) => n.attrs.level as number);
  if (!levels.length) return 1;
  const top = Math.min(...levels);
  const first = blocks[0]!;
  const titleLike = first.type.name === 'heading' && (first.attrs.level as number) === top && levels.filter((l) => l === top).length === 1 && levels.some((l) => l > top);
  if (titleLike) {
    const key = sectionKey(textOf(first));
    if (!KNOWN_SECTIONS.has(key) && !sectionNames.some((x) => sectionKey(x) === key)) return Math.min(...levels.filter((l) => l > top));
  }
  return top;
};
const isSection = (n: PMNode, level: number) => n.type.name === 'heading' && (n.attrs.level as number) === level;

// the section heading of `section` in the manuscript, or null
export function sectionHeading(doc: PMNode, section: string, sectionNames: string[] = [section]): PMNode | null {
  const key = sectionKey(section);
  if (!key) return null;
  const level = sectionLevel(doc, sectionNames);
  return blocksOf(doc).find((n) => isSection(n, level) && sectionKey(textOf(n)) === key) ?? null;
}
// the last block of the section that heading `headingId` opens (before the next heading of the same or a
// higher level), or null when the heading is not a top-level block
export function sectionEndOf(doc: PMNode, headingId: string): PMNode | null {
  const blocks = blocksOf(doc);
  const at = blocks.findIndex((n) => n.attrs.id === headingId && n.type.name === 'heading');
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
// where a new paragraph of `section` goes by default: after the last block of that section
export function sectionEnd(doc: PMNode, section: string, sectionNames: string[] = [section]): PMNode | null {
  const h = sectionHeading(doc, section, sectionNames);
  return h ? sectionEndOf(doc, h.attrs.id as string) : null;
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
    const level = sectionLevel(doc, sections);
    const present = new Set<string>();
    doc.forEach((n) => { if (isSection(n, level)) present.add(sectionKey(textOf(n))); });
    const missing = sections.filter((s) => !present.has(sectionKey(s)));
    if (!missing.length) return { added: [] as string[], revision_id: null, head_revision_id: head };
    const blocks: unknown[] = [];
    doc.forEach((n) => blocks.push(n.toJSON()));
    const indexOf = (id: unknown) => blocks.findIndex((x) => (x as { attrs: { id: string } }).attrs.id === id);
    // a missing section goes after the section that precedes it in the outline; with none present, before
    // the first present section that follows it (review MAJOR 1); with neither, at the end. Nothing the
    // user wrote moves.
    for (const s of missing) {
      const idx = sections.indexOf(s);
      const heading = { type: 'heading', attrs: { id: randomUUID(), level }, content: [{ type: 'text', text: s }] };
      const current = schema.nodeFromJSON({ type: 'doc', content: blocks });
      const prev = sections.slice(0, idx).reverse().find((x) => present.has(sectionKey(x)));
      const next = sections.slice(idx + 1).find((x) => present.has(sectionKey(x)));
      let at = blocks.length;
      if (prev !== undefined) at = indexOf(sectionEnd(current, prev, sections)!.attrs.id) + 1;
      else if (next !== undefined) at = indexOf(sectionHeading(current, next, sections)!.attrs.id);
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
