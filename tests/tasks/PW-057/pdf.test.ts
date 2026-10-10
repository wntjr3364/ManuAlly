// PW-057 — the reading PDF: the app's DOCX converted by a local LibreOffice in its own temporary profile and
// HOME. Where LibreOffice is not installed the export says so (PdfUnavailable); it never writes a fake PDF.
// The conversion test needs LibreOffice installed (this environment has 24.2.7.2); without it the test fails
// and says so — it is never skipped (TST-007B).
import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { docxToPdf, findSoffice, PdfFailed, PdfUnavailable, textCheck } from '../../../packages/exports/src/pdf/index.ts';
import { renderDocx } from '../../../packages/exports/src/docx/index.ts';
import { doc, refs, figures } from '../../export/docx/golden.ts';

const soffice = await findSoffice();

describe('the reading PDF', () => {
  test('the DOCX converts to a PDF holding the manuscript\'s text; the converter and its version are named', async () => {
    expect(soffice, 'LibreOffice (soffice) is needed for the PDF tests: install it or set PW_SOFFICE').toBeTruthy();
    const { bytes } = renderDocx({ doc, refs, figures, style: 'numeric' });
    const home = process.env.HOME;
    const out = await docxToPdf(bytes);
    expect(out.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(out.converter).toEqual({ name: 'libreoffice', version: expect.stringMatching(/^\d+\.\d+/) });
    expect(textCheck(out.text, ['Drought marker paper', 'Introduction'])).toEqual({ status: 'passed', missing: [] });
    expect(textCheck(out.text, ['A heading the paper does not have'])).toMatchObject({ status: 'failed' });
    expect(process.env.HOME).toBe(home);
  }, 180_000);

  test('no LibreOffice: a plain PdfUnavailable, never a PDF', async () => {
    await expect(docxToPdf(Buffer.from('x'), { soffice: null })).rejects.toBeInstanceOf(PdfUnavailable);
    expect(await findSoffice({ PATH: '/nonexistent-dir' })).toBeNull();
    // an override that is not an absolute executable is not used (and PATH is not searched instead)
    expect(await findSoffice({ PATH: process.env.PATH, PW_SOFFICE: 'soffice' })).toBeNull();
    expect(await findSoffice({ PATH: process.env.PATH, PW_SOFFICE: '/nonexistent/soffice' })).toBeNull();
  });

  test('a converter that writes nothing, or something that is not a PDF, or hangs: PdfFailed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw057-fake-'));
    try {
      const nothing = path.join(dir, 'nothing');
      await fs.writeFile(nothing, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      await expect(docxToPdf(Buffer.from('x'), { soffice: nothing })).rejects.toBeInstanceOf(PdfFailed);
      // writes a non-PDF where the PDF should be (the last argument is the input; --outdir precedes it)
      const notPdf = path.join(dir, 'notpdf');
      await fs.writeFile(notPdf, '#!/bin/sh\nfor a; do last=$a; done\nprev=""\nfor a; do if [ "$prev" = "--outdir" ]; then out=$a; fi; prev=$a; done\n[ -n "$out" ] && echo "not a pdf" > "$out/manuscript.pdf"\nexit 0\n', { mode: 0o700 });
      await expect(docxToPdf(Buffer.from('x'), { soffice: notPdf })).rejects.toThrow(/not a PDF/);
      const hang = path.join(dir, 'hang');
      await fs.writeFile(hang, '#!/bin/sh\ncase "$1" in --version) echo "LibreOffice 1.0"; exit 0;; esac\nsleep 30\n', { mode: 0o700 });
      const t0 = Date.now();
      await expect(docxToPdf(Buffer.from('x'), { soffice: hang, timeoutMs: 500 })).rejects.toThrow(/did not finish/);
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('the converter runs with its own HOME and a minimal environment (no secrets passed through)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw057-env-'));
    try {
      const spy = path.join(dir, 'spy');
      const log = path.join(dir, 'env.txt');
      await fs.writeFile(spy, `#!/bin/sh\nenv > ${log}.$$\nexit 0\n`, { mode: 0o700 });
      await expect(docxToPdf(Buffer.from('x'), { soffice: spy, env: { PATH: process.env.PATH, HOME: '/home/owner', ANTHROPIC_API_KEY: 'synthetic-not-a-key', PW_SECRET: 'x' } })).rejects.toBeInstanceOf(PdfFailed);
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith('env.txt.'));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const env = await fs.readFile(path.join(dir, f), 'utf8');
        expect(env).not.toContain('ANTHROPIC_API_KEY');
        expect(env).not.toContain('PW_SECRET');
        expect(env).not.toMatch(/^HOME=\/home\/owner$/m);
        expect(env).toMatch(/^HOME=.*pw-pdf-/m);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('the text check: not_run without text, never passed', () => {
    expect(textCheck(null, ['Introduction'])).toEqual({ status: 'not_run', missing: [] });
    expect(textCheck('Intro duction\nResults', ['Introduction', 'Results'])).toEqual({ status: 'passed', missing: [] });
  });
});
