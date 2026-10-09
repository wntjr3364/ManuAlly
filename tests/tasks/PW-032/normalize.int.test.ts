// PW-032 — normalizing search candidates into the owner's reference library (spec 05, 02).
// TST-032A: duplicates are merged only by a verifiable identifier (DOI, PMID); preprint ↔ published
//   and correction/retraction relations are kept.
// TST-032B: a similar title alone never merges two works; a metadata change adds a new version and
//   never changes what an earlier citation snapshot shows.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createPaper } from '../../../packages/domain/src/papers/index.ts';
import { createSnapshot, getSnapshot } from '../../../packages/domain/src/revisions/index.ts';
import { ingestCandidate, noticesOf, normalizeDoi, possibleDuplicates, referenceIdentifiers, relationsOf, resolveDuplicate } from '../../../packages/domain/src/literature/index.ts';
import { createReference } from '../../../packages/domain/src/references/index.ts';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';

let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let alice: string;
let bob: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  alice = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  bob = (await createOwner(pool, { username: 'bob', password: 'correct horse battery' })).id;
});
afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

// a stored candidate as PW-031 leaves it (a search row and its candidate rows)
async function candidate(owner: string, c: Partial<{ source: 'crossref' | 'pubmed'; source_record_id: string; doi: string | null; title: string; authors: unknown[]; year: number | null; container: string | null; work_type: string | null; is_preprint: boolean; relations: Record<string, string[]>; update_notice: unknown }>) {
  const paper = (await createPaper(pool, owner, { working_title: 'p', article_type: 'research_article' })).id;
  const source = c.source ?? 'crossref';
  const s = (await pool.query(
    `INSERT INTO literature_searches (paper_id, created_by, source, query, params, cache_key, endpoint, status) VALUES ($1, $2, $3, 'q', '{}', repeat('a', 64), 'https://x', 'ok') RETURNING id`,
    [paper, owner, source])).rows[0].id;
  const row = (await pool.query(
    `INSERT INTO literature_candidates (search_id, paper_id, source, rank, source_record_id, doi, title, authors, year, container, work_type, is_preprint, relations, update_notice)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [s, paper, source, c.source_record_id ?? c.doi ?? randomUUID(), c.doi ?? null, c.title ?? 'A synthetic work', JSON.stringify(c.authors ?? [{ family: 'Kim', given: 'J' }]), c.year ?? 2021,
      c.container ?? 'Synthetic Journal', c.work_type ?? 'journal-article', c.is_preprint ?? false, JSON.stringify(c.relations ?? {}), c.update_notice ? JSON.stringify(c.update_notice) : null])).rows[0].id;
  return { paperId: paper as string, candidateId: row as string };
}
const revisions = async (ref: string) => (await pool.query('SELECT id, csl_json, source FROM bibliographic_revisions WHERE reference_id = $1 ORDER BY created_at, id', [ref])).rows;

describe('TST-032A: merged by verifiable identifiers; relations kept', () => {
  test('DOIs are normalized; the same DOI from two searches (or two sources) is one work', async () => {
    expect(normalizeDoi('https://doi.org/10.5555/ABC.1')).toBe('10.5555/abc.1');
    expect(normalizeDoi('doi:10.5555/abc.1 ')).toBe('10.5555/abc.1');
    expect(normalizeDoi('10.5555')).toBeNull();
    const a = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/same.1', title: 'Drought and ABC1' })).candidateId });
    const b = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/SAME.1', title: 'Drought and ABC1' })).candidateId });
    expect(b).toMatchObject({ reference_id: a.reference_id, created: false, new_version: false });
    // PubMed with the same DOI and its PMID: the same work, now also known by the PMID
    const c = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '90000001', doi: '10.5555/same.1', title: 'Drought and ABC1.' })).candidateId });
    expect(c.reference_id).toBe(a.reference_id);
    expect((await referenceIdentifiers(pool, alice, a.reference_id)).map((x) => `${x.kind}:${x.value}`).sort()).toEqual(['doi:10.5555/same.1', 'pmid:90000001']);
    // a later PubMed record with only the PMID finds it too
    const d = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '90000001', doi: null, title: 'Drought and ABC1.' })).candidateId });
    expect(d.reference_id).toBe(a.reference_id);
  });

  test('libraries are per owner: the same DOI for another owner is another work', async () => {
    const a = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/owner.1' })).candidateId });
    const b = await ingestCandidate(pool, { ownerId: bob, candidateId: (await candidate(bob, { doi: '10.5555/owner.1' })).candidateId });
    expect(b.reference_id).not.toBe(a.reference_id);
    await expect(ingestCandidate(pool, { ownerId: bob, candidateId: (await candidate(alice, { doi: '10.5555/owner.2' })).candidateId })).rejects.toThrow(/not found/);
  });

  test('preprint ↔ published and correction/retraction notices become relations (to the work or, if unknown, to its DOI)', async () => {
    const pub = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/pub.1', relations: { has_preprint: ['10.5555/pre.1'] } })).candidateId });
    const pre = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/pre.1', work_type: 'posted-content', is_preprint: true, relations: { is_preprint_of: ['10.5555/pub.1'] } })).candidateId });
    const notice = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/notice.1', title: 'Retraction notice', update_notice: { type: 'retraction', target_doi: '10.5555/gone.1' } })).candidateId });
    const rel = await relationsOf(pool, alice, pub.reference_id);
    expect(rel).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'has_preprint', to_reference_id: pre.reference_id, to_doi: '10.5555/pre.1' })]));
    expect(await relationsOf(pool, alice, pre.reference_id)).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'is_preprint_of', to_reference_id: pub.reference_id })]));
    expect(await relationsOf(pool, alice, notice.reference_id)).toEqual([expect.objectContaining({ relation: 'retraction_of', to_reference_id: null, to_doi: '10.5555/gone.1' })]);
    // a preprint and its published version stay two works (related, not merged)
    expect(pre.reference_id).not.toBe(pub.reference_id);
    // a PubMed "Retracted Publication" flag is kept on the work itself
    const flagged = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '90000002', doi: null, title: 'A retracted synthetic study.', update_notice: { type: 'retracted_publication' } })).candidateId });
    expect(await relationsOf(pool, alice, flagged.reference_id)).toEqual([expect.objectContaining({ relation: 'flagged_retracted', to_reference_id: null, to_doi: null })]);
  });
});

describe('TST-032B: no merging by title; versions never rewrite snapshots', () => {
  test('two works with the same title but no shared identifier stay separate and are listed as a possible duplicate for the owner', async () => {
    const t = 'Drought responses in synthetic roots';
    const a = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/t.1', title: t, year: 2020 })).candidateId });
    const b = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/t.2', title: t.toUpperCase() + '.', year: 2020 })).candidateId });
    const c = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '91000003', doi: null, title: t, year: 2020 })).candidateId });
    expect(new Set([a.reference_id, b.reference_id, c.reference_id]).size).toBe(3);
    const dup = await possibleDuplicates(pool, alice);
    const pairs = dup.filter((d) => [a, b, c].some((x) => x.reference_id === d.reference_a || x.reference_id === d.reference_b));
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs.every((d) => d.reason === 'similar_title' && d.status === 'open')).toBe(true);
    // the owner decides: "distinct" closes the question; nothing is merged automatically either way
    await resolveDuplicate(pool, { ownerId: alice, id: pairs[0]!.id, decision: 'distinct' });
    expect((await possibleDuplicates(pool, alice)).find((d) => d.id === pairs[0]!.id)).toMatchObject({ status: 'distinct' });
    await expect(resolveDuplicate(pool, { ownerId: bob, id: pairs[1]!.id, decision: 'distinct' })).rejects.toThrow(/not found/);
  });

  test('a DOI and a PMID that point at two different works are not merged; the conflict is listed', async () => {
    const x = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/conflict.1', title: 'Work X' })).candidateId });
    const y = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '92000004', doi: null, title: 'Work Y' })).candidateId });
    const z = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '92000004', doi: '10.5555/conflict.1', title: 'Work X or Y' })).candidateId });
    expect(z).toMatchObject({ conflict: true });
    expect([x.reference_id, y.reference_id]).toContain(z.reference_id);
    expect((await possibleDuplicates(pool, alice)).some((d) => d.reason === 'identifier_conflict' && [d.reference_a, d.reference_b].sort().join() === [x.reference_id, y.reference_id].sort().join())).toBe(true);
  });

  test('changed metadata is a new version; an earlier snapshot still shows the version it pinned', async () => {
    const first = await candidate(alice, { doi: '10.5555/version.1', title: 'Original title', year: 2021 });
    const v1 = await ingestCandidate(pool, { ownerId: alice, candidateId: first.candidateId });
    await pool.query('INSERT INTO project_references (paper_id, reference_id, owner_id) VALUES ($1, $2, $3)', [first.paperId, v1.reference_id, alice]);
    const snap = await createSnapshot(pool, first.paperId, alice, 'before the correction');
    const v2 = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/version.1', title: 'Corrected title', year: 2021 })).candidateId });
    expect(v2).toMatchObject({ reference_id: v1.reference_id, created: false, new_version: true });
    const revs = await revisions(v1.reference_id);
    expect(revs.map((r) => r.csl_json.title)).toEqual(['Original title', 'Corrected title']);
    expect(revs.map((r) => r.source)).toEqual(['crossref', 'crossref']);
    const pinned = (await getSnapshot(pool, first.paperId, snap.id))!.references.find((r) => r.reference_id === v1.reference_id);
    expect(pinned?.bibliographic_revision_id).toBe(revs[0].id);
    // the same metadata again adds no version
    expect((await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/version.1', title: 'Corrected title', year: 2021 })).candidateId })).new_version).toBe(false);
    await expect(pool.query("UPDATE bibliographic_revisions SET csl_json = '{}' WHERE reference_id = $1", [v1.reference_id])).rejects.toThrow(/immutable/);
  });

  test('a candidate with neither DOI nor PMID becomes its own work (never merged), with its source record kept', async () => {
    const a = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: null, source_record_id: 'local-1', title: 'A grey-literature report' })).candidateId });
    const b = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: null, source_record_id: 'local-2', title: 'Another grey-literature report' })).candidateId });
    expect(a.reference_id).not.toBe(b.reference_id);
    expect(await referenceIdentifiers(pool, alice, a.reference_id)).toEqual([]);
    expect((await revisions(a.reference_id))[0].csl_json).toMatchObject({ title: 'A grey-literature report' });
  });
});

// review (PW-032): minors 1–3 and nits
describe('review fixes', () => {
  test('nit: DOI forms people paste are understood; nonsense and over-long values are not', () => {
    expect(normalizeDoi('doi.org/10.5555/X.1')).toBe('10.5555/x.1');
    expect(normalizeDoi('https://www.doi.org/10.5555/x.1')).toBe('10.5555/x.1');
    expect(normalizeDoi('http://dx.doi.org/10.5555/x.1')).toBe('10.5555/x.1');
    expect(normalizeDoi('https://doi.org/10.5555/a%2Fb%3C1%3E')).toBe('10.5555/a/b<1>');
    expect(normalizeDoi('10.5555/%E0%A4%A')).toBe('10.5555/%e0%a4%a'); // not decodable: kept as written
    expect(normalizeDoi(`10.5555/${'x'.repeat(301)}`)).toBeNull();
    expect(normalizeDoi(`10.5555/${'x'.repeat(290)}`)).not.toBeNull();
  });

  test('minor 1: a manually entered reference registers its DOI (lowercased): a later candidate finds the same work', async () => {
    const paper = (await createPaper(pool, alice, { working_title: 'manual', article_type: 'research_article' })).id;
    const m = await createReference(pool, { paperId: paper, ownerId: alice, body: { title: 'Manual entry', authors: [{ family: 'Kim' }], doi: '10.5555/MANUAL.1' } });
    expect(m.doi).toBe('10.5555/manual.1');
    expect(await referenceIdentifiers(pool, alice, m.id)).toEqual([{ kind: 'doi', value: '10.5555/manual.1' }]);
    const c = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/manual.1', title: 'Manual entry' })).candidateId });
    expect(c).toMatchObject({ reference_id: m.id, created: false });
    // a manual entry of a DOI already in the library is that work, in another paper too
    const paper2 = (await createPaper(pool, alice, { working_title: 'manual 2', article_type: 'research_article' })).id;
    const m2 = await createReference(pool, { paperId: paper2, ownerId: alice, body: { title: 'Manual entry', authors: [{ family: 'Kim' }], doi: '10.5555/manual.1' } });
    expect(m2.id).toBe(m.id);
    // the same work twice in one paper is refused, not duplicated
    await expect(createReference(pool, { paperId: paper2, ownerId: alice, body: { title: 'Manual entry', authors: [{ family: 'Kim' }], doi: '10.5555/Manual.1' } })).rejects.toThrow(/already/);
  });

  test('minor 1: existing manual DOIs are backfilled as identifiers by the migration', async () => {
    const tmp = await createTempDatabase();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pw032-mig-'));
    try {
      const all = readdirSync(path.resolve('db/migrations')).filter((f) => f.endsWith('.sql')).sort();
      const upto = all.indexOf('pw_032_0001_literature_identity.sql');
      for (const f of all.slice(0, upto + 1)) cpSync(path.resolve('db/migrations', f), path.join(dir, f));
      const p = new pg.Pool({ connectionString: tmp.url, max: 2 });
      try {
        const c = await p.connect();
        await migrate(c, dir);
        const o = (await createOwner(p, { username: 'carol', password: 'correct horse battery' })).id;
        const w1 = (await c.query("INSERT INTO reference_works (owner_id, doi) VALUES ($1, '10.5555/OLD.1') RETURNING id", [o])).rows[0].id;
        const w2 = (await c.query("INSERT INTO reference_works (owner_id, doi) VALUES ($1, '10.5555/old.1') RETURNING id", [o])).rows[0].id;
        for (const f of all.slice(upto + 1)) cpSync(path.resolve('db/migrations', f), path.join(dir, f));
        await migrate(c, dir);
        const ids = (await c.query('SELECT reference_id, value FROM reference_identifiers WHERE owner_id = $1', [o])).rows;
        // one work gets the identifier; two works with the same DOI become a question, not a merge
        expect(ids).toHaveLength(1);
        expect(ids[0].value).toBe('10.5555/old.1');
        const q = (await c.query('SELECT reference_a, reference_b, reason FROM reference_duplicate_questions WHERE owner_id = $1', [o])).rows;
        expect(q).toEqual([{ reference_a: [w1, w2].sort()[0], reference_b: [w1, w2].sort()[1], reason: 'identifier_conflict' }]);
        c.release();
      } finally {
        await p.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await tmp.drop();
    }
  });

  test('minor 2: metadata seen before (alternating sources) adds no new version', async () => {
    const a = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/alt.1', title: 'Alternating sources' })).candidateId });
    await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '93000001', doi: '10.5555/alt.1', title: 'Alternating sources.' })).candidateId });
    for (let i = 0; i < 3; i++) {
      await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/alt.1', title: 'Alternating sources' })).candidateId });
      const r = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '93000001', doi: '10.5555/alt.1', title: 'Alternating sources.' })).candidateId });
      expect(r.new_version).toBe(false);
    }
    expect(await revisions(a.reference_id)).toHaveLength(2);
  });

  test('minor 3: a retraction known only from the notice is visible on the retracted work (either order)', async () => {
    // the notice first, then the work
    await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/rnote.1', title: 'Retraction: X', update_notice: { type: 'retraction', target_doi: '10.5555/rtarget.1' } })).candidateId });
    const t1 = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/rtarget.1', title: 'X' })).candidateId });
    expect(await noticesOf(pool, alice, t1.reference_id)).toEqual([expect.objectContaining({ kind: 'retracted', notice_doi: '10.5555/rnote.1' })]);
    // the work first, then the notice
    const t2 = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/rtarget.2', title: 'Y' })).candidateId });
    expect(await noticesOf(pool, alice, t2.reference_id)).toEqual([]);
    await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/enote.2', title: 'Expression of concern: Y', update_notice: { type: 'expression_of_concern', target_doi: '10.5555/rtarget.2' } })).candidateId });
    expect(await noticesOf(pool, alice, t2.reference_id)).toEqual([expect.objectContaining({ kind: 'expression_of_concern', notice_doi: '10.5555/enote.2' })]);
    // a manually entered target sees a notice that arrived before it
    await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/rnote.3', title: 'Retraction: Z', update_notice: { type: 'retraction', target_doi: '10.5555/rtarget.3' } })).candidateId });
    const paper = (await createPaper(pool, alice, { working_title: 'manual notice', article_type: 'research_article' })).id;
    const m = await createReference(pool, { paperId: paper, ownerId: alice, body: { title: 'Z', authors: [{ family: 'Lee' }], doi: '10.5555/RTARGET.3' } });
    expect(await noticesOf(pool, alice, m.id)).toEqual([expect.objectContaining({ kind: 'retracted' })]);
    // the work's own flag (PubMed / Crossref updated-by) keeps the notice DOI
    const own = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/rtarget.4', title: 'W', update_notice: { type: 'retracted_publication', notice_doi: '10.5555/rnote.4' } })).candidateId });
    expect(await noticesOf(pool, alice, own.reference_id)).toEqual([expect.objectContaining({ kind: 'retracted', notice_doi: '10.5555/rnote.4' })]);
    // other owners see nothing of it
    expect(await noticesOf(pool, bob, own.reference_id)).toEqual([]);
  });

  test('a notice record is not flagged as the thing it announces (PubMed erratum / concern notices)', async () => {
    const n = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { source: 'pubmed', source_record_id: '93000010', doi: null, title: 'Erratum.', update_notice: { type: 'erratum' } })).candidateId });
    expect(await noticesOf(pool, alice, n.reference_id)).toEqual([]);
    expect((await relationsOf(pool, alice, n.reference_id)).map((r) => r.relation)).toEqual(['erratum_for']);
    // Crossref "updated-by" kinds are flags on the work itself
    for (const [type, kind] of [['has_correction', 'correction'], ['has_expression_of_concern', 'expression_of_concern'], ['has_update', 'updated']] as const) {
      const w = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: `10.5555/flag.${type}`, title: `Flag ${type}`, update_notice: { type, notice_doi: `10.5555/n.${type}` } })).candidateId });
      expect(await noticesOf(pool, alice, w.reference_id)).toEqual([expect.objectContaining({ kind, notice_doi: `10.5555/n.${type}` })]);
    }
  });

  test('nit: the same identifier-less candidate ingested twice is one work', async () => {
    const c = await candidate(alice, { doi: null, source_record_id: 'local-again', title: 'Grey literature, once' });
    const a = await ingestCandidate(pool, { ownerId: alice, candidateId: c.candidateId });
    const b = await ingestCandidate(pool, { ownerId: alice, candidateId: c.candidateId });
    expect(b).toMatchObject({ reference_id: a.reference_id, created: false, new_version: false });
  });

  test('nit: a title that changes in a new version is checked again for a same-title work', async () => {
    const a = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/rt.1', title: 'Roots under drought stress' })).candidateId });
    const b = await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/rt.2', title: 'Something else' })).candidateId });
    await ingestCandidate(pool, { ownerId: alice, candidateId: (await candidate(alice, { doi: '10.5555/rt.2', title: 'Roots Under Drought Stress.' })).candidateId });
    const [x, y] = [a.reference_id, b.reference_id].sort();
    expect((await possibleDuplicates(pool, alice)).some((d) => d.reference_a === x && d.reference_b === y && d.reason === 'similar_title')).toBe(true);
  });

  test('nit: duplicate questions cannot be truncated', async () => {
    await expect(pool.query('TRUNCATE reference_duplicate_questions')).rejects.toThrow(/immutable|not allowed|forbid/i);
  });
});
