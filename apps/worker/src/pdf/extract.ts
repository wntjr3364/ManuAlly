// Runs the PDF extractor child (extract-child.mjs) under a real memory limit (RLIMIT_DATA through
// prlimit: decoded PDF streams live outside the V8 heap, so --max-old-space-size alone is not a limit),
// a time limit and an output cap, with an empty environment (no secrets inherited) and its own process
// group (killed whole on every finish). Pages get reading-order flags; nothing is guessed: a failure is
// a failure, an image-only page has no text.
// A failure that depends on the file (a parse error, too much output, positions that are not numbers)
// is final for this extractor version; one that may depend on the moment or the host (time limit,
// start failure, the parser failing to load, a kill by signal, running out of memory — the limit or the
// host's pressure may change) is "transient": the job fails with the reason and may be asked again,
// nothing is stored.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTRACTOR = 'pdfjs-dist@6.4.299/pw-pdf-1';
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract-child.mjs');

export interface Run { o: number; n: number; t: number[]; w: number; h: number }
export interface ExtractedPage { view_box: number[]; rotate: number; text: string; runs: Run[]; flags: string[] }
export type Extraction = { status: 'ok' | 'no_text'; pages: ExtractedPage[] } | { status: 'failed'; reason: string; transient: boolean };

// childPath: tests only (a stand-in extractor); production always runs extract-child.mjs
export interface ExtractLimits { timeoutMs?: number; memoryMb?: number; maxOutputBytes?: number; childPath?: string }
const PRLIMIT = ['/usr/bin/prlimit', '/bin/prlimit'].find((p) => fs.existsSync(p)) ?? null;

export async function extractPdf(bytes: Buffer, limits: ExtractLimits = {}): Promise<Extraction> {
  const timeoutMs = limits.timeoutMs ?? 120_000;
  const maxOut = limits.maxOutputBytes ?? 200 * 1024 * 1024;
  const memoryMb = limits.memoryMb ?? 1024;
  // no memory limit, no parsing (the limit is what keeps one file from exhausting the host)
  if (!PRLIMIT) return { status: 'failed', reason: 'no memory limit is available on this host (prlimit not found)', transient: true };
  type Out = { ok: true; text: string } | { ok: false; reason: string; transient: boolean };
  const out = await new Promise<Out>((resolve) => {
    const child = spawn(PRLIMIT, [`--data=${memoryMb * 1024 * 1024}`, '--', process.execPath, `--max-old-space-size=${Math.max(64, Math.floor(memoryMb / 2))}`, limits.childPath ?? CHILD], {
      env: {}, stdio: ['pipe', 'pipe', 'ignore'], detached: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: Out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `extraction took longer than ${timeoutMs} ms`, transient: true }), timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxOut) return finish({ ok: false, reason: 'extraction output is too large', transient: false });
      chunks.push(c);
    });
    child.on('error', () => finish({ ok: false, reason: 'the extractor could not start', transient: true }));
    child.on('close', (code, signal) => {
      if (done) return;
      // V8 ends a process that hits the memory limit with a fatal trap/abort: a property of the file
      if (signal === 'SIGTRAP' || signal === 'SIGABRT' || code === 133 || code === 134) return finish({ ok: false, reason: `the PDF needs more memory than the parser is allowed (${memoryMb} MB)`, transient: true });
      if (signal || code !== 0) return finish({ ok: false, reason: `the extractor stopped (${signal ?? `exit ${code}`})`, transient: true });
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.on('error', () => { /* the child may exit before reading everything */ });
    child.stdin.end(bytes);
  });
  if (!out.ok) return { status: 'failed', reason: out.reason, transient: out.transient };
  let parsed: { pages?: Omit<ExtractedPage, 'flags'>[]; error?: string; stage?: string };
  try {
    parsed = JSON.parse(out.text);
  } catch {
    return { status: 'failed', reason: 'the extractor gave no readable answer', transient: true };
  }
  if (parsed.error || !Array.isArray(parsed.pages)) {
    const e = String(parsed.error ?? 'no pages');
    // memory exhausted under the limit: a property of the file at this limit, stated as such
    const memory = /allocation failed|out of memory|invalid array length/i.test(e);
    if (memory) return { status: 'failed', reason: `the PDF needs more memory than the parser is allowed (${memoryMb} MB)`, transient: true };
    // only an error while reading this PDF is the PDF's result; the parser failing to load is not
    if (parsed.stage !== 'parse') return { status: 'failed', reason: `the parser could not start (${e.slice(0, 300)})`, transient: true };
    return { status: 'failed', reason: `the PDF could not be parsed (${e.slice(0, 300)})`, transient: false };
  }
  if (!extractorPagesValid(parsed.pages)) return { status: 'failed', reason: 'the extractor gave positions that are not numbers', transient: false };
  const pages = parsed.pages.map((p) => ({ ...p, flags: pageFlags(p) }));
  return { status: pages.some((p) => p.text.trim()) ? 'ok' : 'no_text', pages };
}

// The child's answer is data from a process that read untrusted input: every number must be a finite
// number (a JSON NaN/Infinity arrives as null) and every run must lie inside its page text.
export function extractorPagesValid(pages: unknown[]): boolean {
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return pages.every((x) => {
    const p = x as Omit<ExtractedPage, 'flags'>;
    return !!p && Array.isArray(p.view_box) && p.view_box.length === 4 && p.view_box.every(finite) && [0, 90, 180, 270].includes(p.rotate) && typeof p.text === 'string'
      && Array.isArray(p.runs) && p.runs.every((r) => !!r && Number.isInteger(r.o) && Number.isInteger(r.n) && r.n > 0 && r.o >= 0 && r.o + r.n <= p.text.length && Array.isArray(r.t) && r.t.length === 6 && r.t.every(finite) && finite(r.w) && finite(r.h));
  });
}

// Reading-order and quality risks the owner should see (spec 05: flag, do not fix silently).
export function pageFlags(p: Omit<ExtractedPage, 'flags'>): string[] {
  const flags: string[] = [];
  if (!p.text.trim()) flags.push('no_text');
  if (p.rotate) flags.push('page_rotated');
  if (p.runs.some((r) => Math.abs(r.t[1]!) > 1e-6 || Math.abs(r.t[2]!) > 1e-6)) flags.push('rotated_text');
  if (/\p{L}-\n\p{Ll}/u.test(p.text)) flags.push('hyphenation');
  // two or more left edges, each starting several lines, far apart: likely columns (reading order risk)
  const width = (p.view_box[2]! - p.view_box[0]!) || 1;
  const starts = p.runs.filter((r) => r.o === 0 || p.text[r.o - 1] === '\n').map((r) => Math.round(((r.t[4]! - p.view_box[0]!) / width) * 20));
  const counts = new Map<number, number>();
  for (const s of starts) counts.set(s, (counts.get(s) ?? 0) + 1);
  const busy = [...counts].filter(([, n]) => n >= 3).map(([k]) => k).sort((a, b) => a - b);
  if (busy.length >= 2 && busy.at(-1)! - busy[0]! >= 6) flags.push('possible_columns');
  return flags;
}
