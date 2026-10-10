// PW-057 — the reproducible source archive (spec 10 "v1 export 3"): a ZIP whose manifest names every file
// with its SHA-256 and size, the snapshot it was made from, the versions of everything that made it, and the
// assets left out (with their hash and the reason). verifyArchive() needs nothing but the archive: it checks
// every file, refuses extra or missing ones, and re-renders the DOCX from the archive's own manuscript,
// references and figures to show the output is reproduced byte for byte.
// TST-057A: the archive alone verifies the snapshot's references and outputs.
// TST-057B: originals without the right to share are not put into a share bundle; a blob missing from the
//   store is never shown as a complete archive.
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bibtex, buildArchive, verifyArchive, shareable, ARCHIVE_FORMAT, type ArchiveInput } from '../../../packages/exports/src/archive/index.ts';
import { writeZip } from '../../../packages/exports/src/docx/zip.ts';
import { openZip } from '../../../packages/domain/src/imports/docx/zip.ts';
import { doc, R1, R2, F1, T1 } from '../../export/docx/golden.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const fig = Buffer.from('synthetic figure bytes');
const pdf = Buffer.from('%PDF-1.4 synthetic source');
const open = Buffer.from('%PDF-1.4 open access source');

function input(over: Partial<ArchiveInput> = {}): ArchiveInput {
  return {
    purpose: 'share',
    createdAt: '2026-10-10T00:00:00.000Z',
    paper: { id: '99999999-0000-4000-8000-000000000001', title: 'Drought marker paper' },
    snapshot: { id: '99999999-0000-4000-8000-000000000002', label: 'submitted v1', created_at: '2026-10-09T00:00:00.000Z', story_revision_id: '99999999-0000-4000-8000-000000000003', outline_revision_id: '99999999-0000-4000-8000-000000000004', citation_style: 'numeric', style_version: 'pw-builtin-1' },
    documents: [{ document_id: '99999999-0000-4000-8000-000000000005', kind: 'manuscript', revision_id: '99999999-0000-4000-8000-000000000006', schema_version: 1, content: doc }],
    story: { revision_id: '99999999-0000-4000-8000-000000000003', content: { question: 'q', main_message: 'm' } },
    outline: { revision_id: '99999999-0000-4000-8000-000000000004', content: { nodes: [] } },
    references: [
      { reference_id: R1, bibliographic_revision_id: '99999999-0000-4000-8000-000000000011', csl: { type: 'article-journal', title: 'Root signals under drought', author: [{ family: 'Kim', given: 'Jiyoon' }], issued: { 'date-parts': [[2020]] }, 'container-title': 'Journal of Plant Studies', DOI: '10.1234/jps.2020.1' } },
      { reference_id: R2, bibliographic_revision_id: '99999999-0000-4000-8000-000000000012', csl: { type: 'article-journal', title: 'A second study', author: [{ family: 'Lee', given: 'Ana' }, { family: 'Park', given: 'Min' }], issued: { 'date-parts': [[2019]] } } },
    ],
    figures: [{ id: F1, kind: 'figure', position: 1, title: 'Root induction', caption: 'ABC1 induction in roots under drought (n = 3).' }, { id: T1, kind: 'table', position: 1, title: 'Fold changes', caption: null }],
    assets: [
      { asset_revision_id: '99999999-0000-4000-8000-000000000021', kind: 'figure_file', sha256: sha(fig), byte_size: fig.length, media_type: 'image/png', original_name: 'fig1.png', license: 'own-work', keep_right: 'user_supplied', bytes: fig },
      { asset_revision_id: '99999999-0000-4000-8000-000000000022', kind: 'source_pdf', sha256: sha(pdf), byte_size: pdf.length, media_type: 'application/pdf', original_name: 'kim2020.pdf', license: 'all-rights-reserved', keep_right: 'user_supplied', bytes: pdf },
      { asset_revision_id: '99999999-0000-4000-8000-000000000023', kind: 'source_pdf', sha256: sha(open), byte_size: open.length, media_type: 'application/pdf', original_name: 'open.pdf', license: 'cc-by', keep_right: 'open_license', bytes: open },
    ],
    profile: { id: 'p1', version: 2 },
    aiAudit: [{ proposal_id: 'x', generator: 'mock', applied_revision_id: '99999999-0000-4000-8000-000000000006' }],
    ...over,
  };
}
const entries = (b: Buffer) => openZip(b).names.sort();

describe('TST-057A: the archive alone verifies the snapshot and its outputs', () => {
  test('a share archive: manifest of every file with its hash; references and outputs reproduced from the archive itself', () => {
    const { bytes, manifest } = buildArchive(input());
    expect(manifest).toMatchObject({ format: ARCHIVE_FORMAT, purpose: 'share', status: 'complete', problems: [], snapshot: { label: 'submitted v1', citation_style: 'numeric' } });
    const paths = manifest.files.map((f) => f.path);
    for (const p of ['documents/99999999-0000-4000-8000-000000000005.json', 'story.json', 'outline.json', 'references.csl.json', 'references.bib', 'figures.json', 'outputs/manuscript.docx', 'outputs/manuscript.docx.report.json', 'profile.json', 'ai-assistance.json']) expect(paths).toContain(p);
    // the manifest lists exactly the files in the ZIP
    expect(entries(bytes)).toEqual(['manifest.json', ...paths].sort());
    for (const f of manifest.files) expect(sha(openZip(bytes).read(f.path)!)).toBe(f.sha256);
    // the references are the snapshot's revisions, with their ids
    const csl = JSON.parse(openZip(bytes).read('references.csl.json')!.toString());
    expect(csl.map((c: { id: string; 'pw:bibliographic_revision_id': string }) => [c.id, c['pw:bibliographic_revision_id']])).toEqual([[R1, '99999999-0000-4000-8000-000000000011'], [R2, '99999999-0000-4000-8000-000000000012']]);
    expect(openZip(bytes).read('references.bib')!.toString()).toContain('doi = {10.1234/jps.2020.1}');
    const v = verifyArchive(bytes);
    expect(v).toMatchObject({ ok: true, status: 'complete', problems: [], reproduced: true });
  });

  test('the same input gives the same bytes', () => {
    expect(sha(buildArchive(input()).bytes)).toBe(sha(buildArchive(input()).bytes));
  });

  test('any change is found: a changed file, a removed file, an extra file, a changed output', () => {
    const { bytes, manifest } = buildArchive(input());
    const z = openZip(bytes);
    const all = (): [string, Buffer][] => z.names.map((n) => [n, z.read(n)!]);
    const changed = all().map(([n, b]): [string, Buffer] => (n === 'references.csl.json' ? [n, Buffer.from(b.toString().replace('Root signals', 'Root signal'))] : [n, b]));
    expect(verifyArchive(writeZip(changed))).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('references.csl.json')]) });
    expect(verifyArchive(writeZip(all().filter(([n]) => n !== 'figures.json')))).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('figures.json')]) });
    expect(verifyArchive(writeZip([...all(), ['notes.txt', Buffer.from('x')]]))).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('notes.txt')]) });
    // an output swapped and the manifest updated to match: the re-render shows it is not the archive's output
    const docxEntry = manifest.files.find((f) => f.path === 'outputs/manuscript.docx')!;
    const other = buildArchive(input({ references: input().references.slice(0, 1) })).bytes;
    const otherDocx = openZip(other).read('outputs/manuscript.docx')!;
    const m2 = { ...manifest, files: manifest.files.map((f) => (f.path === docxEntry.path ? { ...f, sha256: sha(otherDocx), bytes: otherDocx.length } : f)) };
    const swapped = all().map(([n, b]): [string, Buffer] => (n === 'outputs/manuscript.docx' ? [n, otherDocx] : n === 'manifest.json' ? [n, Buffer.from(JSON.stringify(m2, null, 2))] : [n, b]));
    expect(verifyArchive(writeZip(swapped))).toMatchObject({ ok: false, reproduced: false });
  });
});

describe('TST-057B: no original without the right to share; no missing blob passed as complete', () => {
  test('a share archive leaves out originals whose licence does not allow sharing, and lists them with hash and reason', () => {
    const { bytes, manifest } = buildArchive(input());
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain(`assets/${sha(fig)}`);
    expect(paths).toContain(`assets/${sha(open)}`);
    expect(paths).not.toContain(`assets/${sha(pdf)}`);
    expect(entries(bytes)).not.toContain(`assets/${sha(pdf)}`);
    expect(manifest.excluded).toEqual([expect.objectContaining({ asset_revision_id: '99999999-0000-4000-8000-000000000022', sha256: sha(pdf), license: 'all-rights-reserved', reason: 'licence_does_not_allow_sharing' })]);
    expect(verifyArchive(bytes).ok).toBe(true);
  });
  test('a private archive (the owner\'s own copy) keeps every original', () => {
    const { manifest } = buildArchive(input({ purpose: 'private' }));
    expect(manifest.files.map((f) => f.path)).toContain(`assets/${sha(pdf)}`);
    expect(manifest.excluded).toEqual([]);
  });
  test('which licences allow a share bundle', () => {
    for (const l of ['own-work', 'cc0', 'public-domain', 'cc-by', 'cc-by-sa']) expect(shareable(l), l).toBe(true);
    for (const l of ['unknown', 'cc-by-nc', 'cc-by-nd', 'cc-by-nc-sa', 'cc-by-nc-nd', 'publisher-tdm', 'all-rights-reserved']) expect(shareable(l), l).toBe(false);
  });
  test('the owner\'s figure file with an unknown licence is left out of a share bundle until the owner marks it', () => {
    const a = input().assets.map((x) => (x.kind === 'figure_file' ? { ...x, license: 'unknown' } : x));
    const { manifest } = buildArchive(input({ assets: a }));
    expect(manifest.excluded.map((e) => e.reason)).toContain('licence_unknown');
  });
  test('a blob missing from the store: the archive says incomplete, names it, and does not verify as complete', () => {
    const a = input().assets.map((x) => (x.kind === 'figure_file' ? { ...x, bytes: null } : x));
    const { bytes, manifest } = buildArchive(input({ assets: a }));
    expect(manifest.status).toBe('incomplete');
    expect(manifest.problems).toEqual([expect.stringContaining(sha(fig))]);
    expect(manifest.missing).toEqual([expect.objectContaining({ sha256: sha(fig), reason: 'missing_in_store' })]);
    const v = verifyArchive(bytes);
    expect(v.ok).toBe(false);
    expect(v.status).toBe('incomplete');
  });
  test('a blob whose bytes do not match its recorded hash is missing, not included', () => {
    const a = input().assets.map((x) => (x.kind === 'figure_file' ? { ...x, bytes: Buffer.from('tampered') } : x));
    const { manifest } = buildArchive(input({ assets: a }));
    expect(manifest.status).toBe('incomplete');
    expect(manifest.files.map((f) => f.path)).not.toContain(`assets/${sha(fig)}`);
  });
});

describe('the verifier refuses what a hand-made archive could hide', () => {
  const rebuilt = (edit: (files: [string, Buffer][], m: Record<string, unknown>) => [string, Buffer][]) => {
    const { bytes, manifest } = buildArchive(input());
    const z = openZip(bytes);
    const m = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    const files = edit(z.names.filter((n) => n !== 'manifest.json').map((n): [string, Buffer] => [n, z.read(n)!]), m);
    return writeZip([['manifest.json', Buffer.from(JSON.stringify(m))], ...files]);
  };
  test('a name used twice', () => {
    const b = rebuilt((f) => [...f, ['figures.json', Buffer.from('[]')]]);
    expect(verifyArchive(b)).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('more than once')]) });
  });
  test('a path that would escape the folder it is unpacked in', () => {
    const b = rebuilt((f, m) => {
      const evil = Buffer.from('x');
      (m.files as ManifestLike[]).push({ path: '../evil', sha256: sha(evil), bytes: 1, role: 'asset' });
      return [...f, ['../evil', evil]];
    });
    expect(verifyArchive(b)).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('unsafe')]) });
  });
  test('no manifest, or not ours', () => {
    expect(verifyArchive(writeZip([['story.json', Buffer.from('{}')]]))).toMatchObject({ ok: false, status: 'invalid', problems: ['manifest.json is missing'] });
    expect(verifyArchive(writeZip([['manifest.json', Buffer.from('{"format":"other"}')]]))).toMatchObject({ ok: false, problems: [expect.stringContaining('manifest')] });
    expect(verifyArchive(Buffer.from('not a zip'))).toMatchObject({ ok: false, status: 'invalid' });
  });
  test('references that are not the snapshot\'s revisions, with every hash made consistent', () => {
    const b = rebuilt((f, m) => {
      (m.references as { bibliographic_revision_id: string }[])[0]!.bibliographic_revision_id = '99999999-0000-4000-8000-0000000000ff';
      return f;
    });
    expect(verifyArchive(b)).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('reference revisions')]) });
  });
  test('an original said to be left out but present anyway', () => {
    const b = rebuilt((f, m) => [...f, [`assets/${(m.excluded as { sha256: string }[])[0]!.sha256}`, pdf]]);
    expect(verifyArchive(b).problems).toEqual(expect.arrayContaining([expect.stringContaining('listed as left out')]));
  });
  test('review M1: a swapped output with `render` removed from the manifest does not verify', () => {
    const forged = Buffer.from('not the app\'s render');
    const b = rebuilt((f, m) => {
      m.render = null;
      (m.files as ManifestLike[]).forEach((x) => { if (x.path === 'outputs/manuscript.docx') { x.sha256 = sha(forged); x.bytes = forged.length; } });
      return f.map(([n, x]): [string, Buffer] => [n, n === 'outputs/manuscript.docx' ? forged : x]);
    });
    expect(verifyArchive(b)).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('render is missing')]) });
    // outputs removed too: the manuscript still needs its render
    const c = rebuilt((f, m) => {
      m.render = null;
      m.files = (m.files as ManifestLike[]).filter((x) => !x.path.startsWith('outputs/'));
      return f.filter(([n]) => !n.startsWith('outputs/'));
    });
    expect(verifyArchive(c).ok).toBe(false);
    // render pointing at a document that is not a manuscript
    const d = rebuilt((f, m) => { (m.render as { document_id: string }).document_id = '99999999-0000-4000-8000-0000000000aa'; return f; });
    expect(verifyArchive(d)).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('not a manuscript')]) });
  });
  test('review m1: a private archive relabelled as share does not verify', () => {
    const { bytes } = buildArchive(input({ purpose: 'private' }));
    const z = openZip(bytes);
    const m = JSON.parse(z.read('manifest.json')!.toString());
    m.purpose = 'share';
    const relabelled = writeZip([['manifest.json', Buffer.from(JSON.stringify(m))], ...z.names.filter((n) => n !== 'manifest.json').map((n): [string, Buffer] => [n, z.read(n)!])]);
    expect(verifyArchive(relabelled)).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('all-rights-reserved')]) });
    expect(verifyArchive(bytes).ok).toBe(true);
  });
  test('an original stored under a name that is not its hash does not verify', () => {
    const b = rebuilt((f, m) => {
      const x = Buffer.from('other bytes');
      (m.files as ManifestLike[]).push({ path: `assets/${'0'.repeat(64)}`, sha256: sha(x), bytes: x.length, role: 'asset', license: 'cc-by' } as ManifestLike);
      return [...f, [`assets/${'0'.repeat(64)}`, x]];
    });
    expect(verifyArchive(b)).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('under its own hash')]) });
  });
  test('a manifest edited to say complete over a missing original still fails (the file is not there)', () => {
    const a = input().assets.map((x) => (x.kind === 'figure_file' ? { ...x, bytes: null } : x));
    const { bytes } = buildArchive(input({ assets: a }));
    const z = openZip(bytes);
    const m = JSON.parse(z.read('manifest.json')!.toString());
    m.status = 'complete';
    m.missing = [];
    m.files.push({ path: `assets/${sha(fig)}`, sha256: sha(fig), bytes: fig.length, role: 'asset' });
    const forged = writeZip([['manifest.json', Buffer.from(JSON.stringify(m))], ...z.names.filter((n) => n !== 'manifest.json').map((n): [string, Buffer] => [n, z.read(n)!])]);
    expect(verifyArchive(forged)).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('not in the archive')]) });
  });
});

type ManifestLike = { path: string; sha256: string; bytes: number; role: string };

describe('archive contents', () => {
  test('BibTeX escapes what would break LaTeX, keeps DOIs verbatim, and gives distinct keys', () => {
    const b = bibtex([
      { reference_id: R1, bibliographic_revision_id: 'r1', csl: { type: 'article-journal', title: 'Cost {ratio} 50% & more_x', author: [{ family: 'Kim', given: 'J' }], issued: { 'date-parts': [[2020]] }, DOI: '10.1/a_b' } },
      { reference_id: R2, bibliographic_revision_id: 'r2', csl: { type: 'book', title: 'Another', author: [{ family: 'Kim', given: 'K' }], issued: { 'date-parts': [[2020]] } } },
    ]);
    expect(b).toContain('title = {Cost \\{ratio\\} 50\\% \\& more\\_x}');
    expect(b).toContain('doi = {10.1/a_b}');
    expect(b).toMatch(/@article\{Kim2020,/);
    expect(b).toMatch(/@book\{Kim2020a,/);
  });
  test('the same bytes recorded under a shareable and a non-shareable licence stay out of a share bundle', () => {
    const twin = { ...input().assets[2]!, asset_revision_id: '99999999-0000-4000-8000-000000000030', license: 'cc-by-nc' };
    const { bytes, manifest } = buildArchive(input({ assets: [...input().assets, twin] }));
    expect(manifest.files.map((f) => f.path)).not.toContain(`assets/${sha(open)}`);
    expect(manifest.excluded.map((e) => [e.asset_revision_id, e.reason])).toEqual(expect.arrayContaining([['99999999-0000-4000-8000-000000000023', 'licence_conflict'], ['99999999-0000-4000-8000-000000000030', 'licence_does_not_allow_sharing']]));
    expect(verifyArchive(bytes)).toMatchObject({ ok: true });
    expect(buildArchive(input({ purpose: 'private', assets: [...input().assets, twin] })).manifest.files.map((f) => f.path)).toContain(`assets/${sha(open)}`);
  });
  test('two asset revisions with the same bytes are stored once', () => {
    const extra = { ...input().assets[0]!, asset_revision_id: '99999999-0000-4000-8000-000000000029' };
    const { manifest } = buildArchive(input({ assets: [...input().assets, extra] }));
    expect(manifest.files.filter((f) => f.path === `assets/${sha(fig)}`)).toHaveLength(1);
    expect(manifest.status).toBe('complete');
  });
  test('a snapshot without a manuscript has no output and still verifies', () => {
    const { bytes, manifest } = buildArchive(input({ documents: [] }));
    expect(manifest.render).toBeNull();
    expect(verifyArchive(bytes)).toMatchObject({ ok: true, reproduced: null });
  });
  test('a retracted reference is recorded and reproduced in the re-render', () => {
    const { bytes, manifest } = buildArchive(input({ retracted: [R1] }));
    expect(manifest.render!.retracted).toEqual([R1]);
    const report = JSON.parse(openZip(bytes).read('outputs/manuscript.docx.report.json')!.toString());
    expect(report.issues.map((i: { kind: string }) => i.kind)).toContain('retracted_reference');
    expect(verifyArchive(bytes)).toMatchObject({ ok: true, reproduced: true });
  });
});

describe('the command-line verifier (the archive alone, outside the app)', () => {
  const cli = (file: string) => spawnSync(process.execPath, ['packages/exports/src/archive/cli.ts', file], { encoding: 'utf8' });
  test('exit 0 for a complete archive, 1 for an incomplete or altered one, 2 for an unreadable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw057-cli-'));
    try {
      const good = path.join(dir, 'good.zip');
      fs.writeFileSync(good, buildArchive(input()).bytes);
      const r = cli(good);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, status: 'complete', reproduced: true, purpose: 'share' });
      const bad = path.join(dir, 'bad.zip');
      fs.writeFileSync(bad, buildArchive(input({ assets: input().assets.map((x) => ({ ...x, bytes: null })) })).bytes);
      expect(cli(bad).status).toBe(1);
      expect(cli(path.join(dir, 'none.zip')).status).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
