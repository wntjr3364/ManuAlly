// Runs the PDF extractor child (extract-child.mjs) with a memory cap, a time limit and an output cap,
// an empty environment (no secrets inherited) and its own process group (killed whole on timeout).
// Pages get reading-order flags; nothing is guessed: a failure is a failure, an image-only page has
// no text.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTRACTOR = 'pdfjs-dist@6.4.299/pw-pdf-1';
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract-child.mjs');

export interface Run { o: number; n: number; t: number[]; w: number; h: number }
export interface ExtractedPage { view_box: number[]; rotate: number; text: string; runs: Run[]; flags: string[] }
export type Extraction = { status: 'ok' | 'no_text'; pages: ExtractedPage[] } | { status: 'failed'; reason: string };

export interface ExtractLimits { timeoutMs?: number; maxOldSpaceMb?: number; maxOutputBytes?: number }

export async function extractPdf(bytes: Buffer, limits: ExtractLimits = {}): Promise<Extraction> {
  const timeoutMs = limits.timeoutMs ?? 120_000;
  const maxOut = limits.maxOutputBytes ?? 200 * 1024 * 1024;
  const out = await new Promise<{ ok: true; text: string } | { ok: false; reason: string }>((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${limits.maxOldSpaceMb ?? 768}`, CHILD], {
      env: {}, stdio: ['pipe', 'pipe', 'ignore'], detached: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: { ok: true; text: string } | { ok: false; reason: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `extraction took longer than ${timeoutMs} ms` }), timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxOut) return finish({ ok: false, reason: 'extraction output is too large' });
      chunks.push(c);
    });
    child.on('error', () => finish({ ok: false, reason: 'the extractor could not start' }));
    child.on('close', (code, signal) => {
      if (done) return;
      if (signal || code !== 0) return finish({ ok: false, reason: `the extractor stopped (${signal ?? `exit ${code}`}; memory limit?)` });
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.on('error', () => { /* the child may exit before reading everything */ });
    child.stdin.end(bytes);
  });
  if (!out.ok) return { status: 'failed', reason: out.reason };
  let parsed: { pages?: Omit<ExtractedPage, 'flags'>[]; error?: string };
  try {
    parsed = JSON.parse(out.text);
  } catch {
    return { status: 'failed', reason: 'the extractor gave no readable answer' };
  }
  if (parsed.error || !Array.isArray(parsed.pages)) return { status: 'failed', reason: `the PDF could not be parsed (${String(parsed.error ?? 'no pages').slice(0, 300)})` };
  const pages = parsed.pages.map((p) => ({ ...p, flags: pageFlags(p) }));
  return { status: pages.some((p) => p.text.trim()) ? 'ok' : 'no_text', pages };
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
