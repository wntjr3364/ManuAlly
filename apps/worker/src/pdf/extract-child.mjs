// PDF text extraction in its own process (PW-035, spec 09: the parser runs as a separate,
// resource-limited process). Reads the PDF bytes from stdin and writes one JSON line to stdout:
// { pages: [{ view_box, rotate, text, runs: [{ o, n, t, w, h }] }] } or { error }.
// No script evaluation, no font loading, no XFA; a parse error fails the whole document (no partial
// text). Text runs keep their transform so a quote can be located on the page later.
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const MAX_RUNS_PER_PAGE = 50_000;
const WARMUP = (() => {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 33 >>\nstream\nBT /F1 12 Tf 10 50 Td (ok) Tj ET\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.7\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  return out + `xref\n0 6\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
})();
const MAX_TEXT = 20_000_000;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

// 'load' until the parser and the bytes are ready: an error before that is about this process, not the PDF
let stage = 'load';

async function main() {
  const require = createRequire(import.meta.url);
  const pkg = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjs = await import(path.join(pkg, 'legacy/build/pdf.mjs'));
  // warm up the parser on a tiny built-in document (its worker and standard-font data load lazily), so
  // that a broken installation fails here, in the 'load' stage, not while parsing the owner's PDF
  const warm = pdfjs.getDocument({ data: new Uint8Array(Buffer.from(WARMUP, 'latin1')), disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: true, standardFontDataUrl: path.join(pkg, 'standard_fonts') + path.sep, verbosity: 0 });
  await (await (await warm.promise).getPage(1)).getTextContent();
  await warm.destroy();
  const data = new Uint8Array(await readStdin());
  stage = 'parse';
  const task = pdfjs.getDocument({
    data, disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: true,
    standardFontDataUrl: path.join(pkg, 'standard_fonts') + path.sep, verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    const runs = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      if (it.str.length) {
        runs.push({ o: text.length, n: it.str.length, t: it.transform.map((x) => Math.round(x * 1000) / 1000), w: Math.round(it.width * 1000) / 1000, h: Math.round(it.height * 1000) / 1000 });
        text += it.str;
      }
      if (it.hasEOL) text += '\n';
      if (runs.length > MAX_RUNS_PER_PAGE) throw new Error('too many text runs on a page');
    }
    total += text.length;
    if (total > MAX_TEXT) throw new Error('too much text');
    pages.push({ view_box: page.view, rotate: ((page.rotate % 360) + 360) % 360, text, runs });
    page.cleanup();
  }
  await task.destroy();
  process.stdout.write(JSON.stringify({ pages }) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ stage, error: String(e?.name ?? 'Error').slice(0, 50) + ': ' + String(e?.message ?? e).slice(0, 300) }) + '\n');
});
