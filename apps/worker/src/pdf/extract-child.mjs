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
const MAX_TEXT = 20_000_000;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

async function main() {
  const require = createRequire(import.meta.url);
  const pkg = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjs = await import(path.join(pkg, 'legacy/build/pdf.mjs'));
  const data = new Uint8Array(await readStdin());
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
  process.stdout.write(JSON.stringify({ error: String(e?.name ?? 'Error').slice(0, 50) + ': ' + String(e?.message ?? e).slice(0, 300) }) + '\n');
});
