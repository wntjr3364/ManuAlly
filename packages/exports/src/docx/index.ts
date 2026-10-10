// DOCX and CSL-JSON export (PW-056). renderDocx(): the stored document → a DOCX (./render.ts), checked
// (./check.ts) and read back with the app's own DOCX reader to compare, block by block, what was meant to be
// written with what the file holds. cslJson(): the stored CSL-JSON records of the cited references, in
// bibliography order, with their stable ids — for a reference manager to restyle with any CSL style (the DOCX
// itself uses the built-in pinned styles; journal CSL styles are not rendered in v1).
import { bibliography, referenceOccurrences, type CitationStyle, type RefMeta } from '@pw/editor-core';
import { parseDocx } from '@pw/domain/imports/docx/index.ts';
import { layout, writeDocx, RENDERER_VERSION, XML_INVALID, type FigureIn, type OutBlock, type OutInline } from './render.ts';
import { checkContent, Issues, type ExportStatus, type Issue } from './check.ts';

export { RENDERER_VERSION };
export type { ExportStatus, Issue, FigureIn };
export interface ExportReport {
  status: ExportStatus; issues: Issue[]; style: CitationStyle; style_version: string; renderer_version: string;
  readback: { ok: boolean; mismatches: string[] };
  counts: { blocks: number; citations: number; references: number; figures: number };
}

type Seen = { kind: string; level?: number; runs?: string; cells?: string[][] };
const marksKey = (m: string[]) => [...m].sort().join('+');
// text with its formatting, adjacent equal formatting merged (as any reader merges runs)
const runsOf = (xs: { text: string; marks: string[] }[]) => {
  const out: [string, string][] = [];
  for (const x of xs) {
    const t = x.text.replace(XML_INVALID, '');
    if (!t) continue;
    const k = marksKey(x.marks);
    if (out.length && out.at(-1)![1] === k) out.at(-1)![0] += t;
    else out.push([t, k]);
  }
  if (out.length) out.at(-1)![0] = out.at(-1)![0].replace(/\s+$/, '');
  return out.filter(([t]) => t).map(([t, k]) => `${k}:${t}`).join('|');
};
const cellText = (c: OutInline[]) => c.map((i) => i.text.replace(XML_INVALID, '')).join('');
function expected(blocks: readonly OutBlock[]): Seen[] {
  const out: Seen[] = [];
  for (const b of blocks) {
    if (b.type === 'table') { out.push({ kind: 'table', cells: b.rows.map((r) => r.map(cellText)) }); continue; }
    const runs = runsOf(b.content);
    if (!runs) continue; // an empty paragraph is not read back
    out.push(b.type === 'heading' ? { kind: 'heading', level: b.level, runs } : { kind: 'paragraph', runs });
  }
  return out;
}
type Back = { type: string; attrs: { level?: number }; content?: { text?: string; marks?: { type: string }[]; content?: { content?: { text?: string }[] }[] }[] };
function readBack(bytes: Buffer): Seen[] {
  return (parseDocx(bytes, {}).doc.content as Back[]).map((b) => {
    if (b.type === 'table') return { kind: 'table', cells: (b.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((i) => i.text ?? '').join(''))) };
    const runs = runsOf((b.content ?? []).map((i) => ({ text: i.text ?? '', marks: (i.marks ?? []).map((m) => m.type) })));
    return b.type === 'heading' ? { kind: 'heading', level: b.attrs.level, runs } : { kind: 'paragraph', runs };
  });
}

// `write` is the file writer (replaceable in tests, to show that a file that does not read back as intended is
// reported, never passed as clean)
export function renderDocx(a: { doc: unknown; refs: readonly RefMeta[]; figures: readonly FigureIn[]; style: CitationStyle }, write: typeof writeDocx = writeDocx): { bytes: Buffer; report: ExportReport } {
  const l = layout(a.doc, a.refs, a.figures, a.style);
  const issues = new Issues();
  checkContent(l, issues);
  const controls = l.typed.join('').match(XML_INVALID)?.length ?? 0;
  if (controls) issues.add('control_characters', 'warning', undefined, controls);
  // a file with errors says so in its own header (it cannot pass for a clean export)
  const draftNote = (status: ExportStatus) => (status === 'draft_with_errors' ? `초안 — 내보내기 검사에서 고칠 문제가 있습니다(${issues.list().filter((i) => i.severity === 'error').map((i) => i.kind).join(', ')}). 제출용이 아닙니다.` : null);
  let bytes = write(l.blocks, draftNote(issues.status()));
  // read back and compare
  const want = expected(l.blocks);
  const got = readBack(bytes);
  const mismatches: string[] = [];
  const n = Math.max(want.length, got.length);
  for (let k = 0; k < n && mismatches.length < 20; k++) {
    if (JSON.stringify(want[k] ?? null) !== JSON.stringify(got[k] ?? null)) mismatches.push(`block ${k + 1}: expected ${JSON.stringify(want[k] ?? null).slice(0, 200)}, file has ${JSON.stringify(got[k] ?? null).slice(0, 200)}`);
  }
  if (mismatches.length) {
    issues.add('readback_mismatch', 'error', mismatches[0], mismatches.length);
    bytes = write(l.blocks, draftNote(issues.status()));
  }
  const occ = referenceOccurrences(a.doc);
  return {
    bytes,
    report: {
      status: issues.status(), issues: issues.list(), style: a.style, style_version: l.styleVersion, renderer_version: RENDERER_VERSION,
      readback: { ok: mismatches.length === 0, mismatches },
      counts: { blocks: want.length, citations: occ.citations.length, references: bibliography(occ.citations, a.refs, a.style).length, figures: occ.figures.length },
    },
  };
}

export function cslJson(doc: unknown, refs: readonly RefMeta[], stored: ReadonlyMap<string, Record<string, unknown>>, style: CitationStyle): Record<string, unknown>[] {
  const occ = referenceOccurrences(doc);
  return bibliography(occ.citations, refs, style).filter((b) => stored.has(b.id)).map((b) => ({ ...stored.get(b.id)!, id: b.id }));
}
