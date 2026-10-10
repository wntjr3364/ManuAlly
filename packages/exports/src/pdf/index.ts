// The reading PDF (PW-057, spec 10 "v1 export 2"): the app's own DOCX (PW-056) converted by a LibreOffice
// installed on the same machine (`soffice --headless --convert-to pdf`). Each conversion runs in its own
// temporary folder with its own LibreOffice profile and HOME (never the user's), a minimal environment, no
// network-facing option, and a time limit after which the whole process group is stopped; the folder is
// removed afterwards. The PDF is for reading: no layout promise beyond what LibreOffice makes of the DOCX.
// Where no LibreOffice is found the export says so plainly (PdfUnavailable); it never writes a fake PDF.
// The text check reads the PDF back with pdftotext (when installed) and looks for the manuscript's headings;
// without pdftotext the check is 'not_run', not passed.
import { spawn } from 'node:child_process';
import { constants as fsc } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class PdfUnavailable extends Error {}
export class PdfFailed extends Error {}
export const PDF_TIMEOUT_MS = 120_000;

async function executable(p: string) {
  try { await fs.access(p, fsc.X_OK); return (await fs.stat(p)).isFile(); } catch { return false; }
}
// PW_SOFFICE (a path) first, then soffice / libreoffice on PATH
export async function findTool(names: readonly string[], env: NodeJS.ProcessEnv = process.env, override?: string): Promise<string | null> {
  if (override !== undefined) return (path.isAbsolute(override) && (await executable(override))) ? override : null;
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    for (const n of names) if (await executable(path.join(dir, n))) return path.join(dir, n);
  }
  return null;
}
export const findSoffice = (env: NodeJS.ProcessEnv = process.env) => findTool(['soffice', 'libreoffice'], env, env.PW_SOFFICE);
export const findPdftotext = (env: NodeJS.ProcessEnv = process.env) => findTool(['pdftotext'], env, env.PW_PDFTOTEXT);

interface Ran { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
function run(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOut?: number }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < (o.maxOut ?? 65536)) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 65536) stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }, o.timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // anything the converter left running in its group goes with it
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* none left */ }
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

// the converter's environment: its own HOME and temp folder, a plain locale, PATH only for its helpers
const isolatedEnv = (dir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ HOME: dir, TMPDIR: dir, PATH: env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SAL_USE_VCLPLUGIN: 'svp' });

export async function libreofficeVersion(soffice: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-pdf-'));
  try {
    const r = await run(soffice, ['--version'], { cwd: dir, env: isolatedEnv(dir, env), timeoutMs: 30_000 });
    return (r.stdout.match(/LibreOffice\s+([0-9][0-9.]*)/)?.[1]) ?? 'unknown';
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface PdfResult { bytes: Buffer; converter: { name: 'libreoffice'; version: string }; text: string | null }

export async function docxToPdf(docx: Buffer, o: { env?: NodeJS.ProcessEnv; timeoutMs?: number; soffice?: string | null } = {}): Promise<PdfResult> {
  const env = o.env ?? process.env;
  const soffice = o.soffice === undefined ? await findSoffice(env) : o.soffice;
  if (!soffice) throw new PdfUnavailable('PDF로 바꿀 LibreOffice(soffice)가 이 컴퓨터에 없습니다. LibreOffice를 설치하거나 PW_SOFFICE에 경로를 지정하세요. DOCX 내보내기는 그대로 쓸 수 있습니다.');
  const version = await libreofficeVersion(soffice, env);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-pdf-'));
  try {
    const input = path.join(dir, 'manuscript.docx');
    const out = path.join(dir, 'out');
    await fs.mkdir(out, { mode: 0o700 });
    await fs.writeFile(input, docx, { mode: 0o600 });
    const r = await run(soffice, ['--headless', '--invisible', '--norestore', '--nolockcheck', '--nodefault', '--nologo', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pdf', '--outdir', out, input],
      { cwd: dir, env: isolatedEnv(dir, env), timeoutMs: o.timeoutMs ?? PDF_TIMEOUT_MS });
    if (r.timedOut) throw new PdfFailed(`LibreOffice did not finish within ${Math.round((o.timeoutMs ?? PDF_TIMEOUT_MS) / 1000)} s`);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path.join(out, 'manuscript.pdf'));
    } catch {
      throw new PdfFailed(`LibreOffice wrote no PDF (exit ${r.code ?? r.signal}): ${r.stderr.trim().slice(0, 300)}`);
    }
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfFailed('LibreOffice wrote a file that is not a PDF');
    return { bytes, converter: { name: 'libreoffice', version }, text: await pdfText(bytes, dir, env) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function pdfText(pdf: Buffer, dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const tool = await findPdftotext(env);
  if (!tool) return null;
  const file = path.join(dir, 'check.pdf');
  await fs.writeFile(file, pdf, { mode: 0o600 });
  const r = await run(tool, ['-enc', 'UTF-8', file, '-'], { cwd: dir, env: isolatedEnv(dir, env), timeoutMs: 30_000, maxOut: 16 * 1024 * 1024 });
  return r.code === 0 ? r.stdout : null;
}

// the headings must be in the PDF's text (spacing aside); 'not_run' when the text could not be read
const squash = (s: string) => s.normalize('NFC').replace(/\s+/g, '');
export function textCheck(text: string | null, headings: readonly string[]): { status: 'passed' | 'failed' | 'not_run'; missing: string[] } {
  if (text === null) return { status: 'not_run', missing: [] };
  const t = squash(text);
  const missing = headings.filter((h) => squash(h) && !t.includes(squash(h)));
  return { status: missing.length ? 'failed' : 'passed', missing: missing.slice(0, 10) };
}
