import zlib from 'node:zlib';
// Synthetic PDFs for PW-035 (no real papers): text lines placed with Td (or a full Tm matrix for
// rotated text), optional /Rotate, a valid xref table.
export interface PageSrc { lines?: [number, number, string][]; raw?: string; rotate?: 0 | 90 | 180 | 270 }
const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
export function makePdf(pages: PageSrc[], opts: { brokenCatalog?: boolean } = {}): Buffer {
  const objs: string[] = [opts.brokenCatalog ? '<< /Type /Catalog /Pages 99 0 R >>' : '<< /Type /Catalog /Pages 2 0 R >>'];
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const fontId = 3 + pages.length * 2;
  pages.forEach((p, i) => {
    const stream = p.raw ?? (p.lines ?? []).map(([x, y, t]) => `BT /F1 12 Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${p.rotate ? ` /Rotate ${p.rotate}` : ''} /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.7\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
export const SENTENCE = 'ABC1 was induced 2.4-fold under drought.';
export const PAPER_V1 = () => makePdf([
  { lines: [[72, 720, SENTENCE], [72, 700, 'Roots were sampled at day 7.'], [72, 680, 'The control was not induced.']] },
  { rotate: 90, lines: [[72, 720, 'Second page: ABC1 in leaves was unchanged.']] },
]);
// a corrected revision: the sentence moved down and to page 2
export const PAPER_V2 = () => makePdf([
  { lines: [[72, 720, 'Corrected version.'], [72, 700, 'Roots were sampled at day 7.']] },
  { lines: [[72, 600, SENTENCE]] },
]);

// a small file whose one content stream inflates to `inflatedBytes` (a decompression bomb for the parser)
export function bombPdf(inflatedBytes: number): Buffer {
  const content = Buffer.concat([Buffer.from('BT /F1 12 Tf 72 720 Td (bomb) Tj ET\n', 'latin1'), Buffer.alloc(inflatedBytes, 32)]);
  const data = zlib.deflateSync(content, { level: 9 });
  const head = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n';
  const s4 = `4 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`;
  const tail = '\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
  return Buffer.concat([Buffer.from(head + s4, 'latin1'), data, Buffer.from(tail, 'latin1')]);
}
